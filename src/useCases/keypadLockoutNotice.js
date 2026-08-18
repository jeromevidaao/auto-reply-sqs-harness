/**
 * Isolated keypad-lockout guest notice.
 *
 * guestCheckInDetect enqueues act=keypad_lockout_notice on grok_message.
 * This path never goes through Grok. Occupancy comes from Hospitable + HE.
 * simulate / sendGuests=false never POSTs to the guest thread.
 */
import {
  alreadySentLockoutNotice,
  buildLockoutGuestNotify,
  decideLockoutRecipients,
  extractLockoutNoticeContext,
  fillGuestTemplate,
  guestFirstName,
  isKeypadLockoutNoticeTurn,
  loadCurrentGuestsByListing,
  lockPhraseFor,
  nyTodayAndHour,
} from './keypadLockoutOccupancy.js';

export { isKeypadLockoutNoticeTurn, KEYPAD_LOCKOUT_NOTICE_ACT } from './keypadLockoutOccupancy.js';

async function recentThread(recipient, { hospitableClient, homeExchangeClient }) {
  if (recipient.platform === 'homeexchange' && homeExchangeClient?.listMessages) {
    return homeExchangeClient.listMessages(recipient.conversationId);
  }
  if (recipient.platform === 'hospitable' && hospitableClient) {
    if (recipient.reservationId && hospitableClient.getReservationMessages) {
      return hospitableClient.getReservationMessages(recipient.reservationId, 8);
    }
    if (recipient.conversationId && hospitableClient.getConversationMessages) {
      return hospitableClient.getConversationMessages(recipient.conversationId, 8);
    }
  }
  return [];
}

async function sendToRecipient(recipient, body, { hospitableClient, homeExchangeClient }) {
  if (recipient.platform === 'homeexchange') {
    if (!homeExchangeClient?.sendMessage) {
      return { sent: false, sendSkipReason: 'no_homeexchange_client' };
    }
    if (!recipient.conversationId) {
      return { sent: false, sendError: 'missing_conversation_id' };
    }
    await homeExchangeClient.sendMessage(recipient.conversationId, body);
    return { sent: true };
  }
  if (!hospitableClient) {
    return { sent: false, sendSkipReason: 'no_hospitable_client' };
  }
  if (recipient.reservationId && hospitableClient.sendMessageToReservation) {
    await hospitableClient.sendMessageToReservation(recipient.reservationId, body);
    return { sent: true };
  }
  if (recipient.conversationId && hospitableClient.sendMessage) {
    await hospitableClient.sendMessage(recipient.conversationId, body);
    return { sent: true };
  }
  return { sent: false, sendError: 'missing_reservation_or_conversation' };
}

export async function handleKeypadLockoutNotice({
  event,
  hospitableClient = null,
  homeExchangeClient = null,
  notifyOwner = null,
  now = new Date(),
} = {}) {
  const ctx = extractLockoutNoticeContext(event);
  const { today, hourNy } = nyTodayAndHour(now);
  const lockPhrase = ctx.lockPhrase || lockPhraseFor(ctx.lockName);

  let guestsByListing = { '20904545': [], '20150380': [], '24259977': [] };
  let occupancyError = null;
  try {
    guestsByListing = await loadCurrentGuestsByListing({
      hospitableClient,
      homeExchangeClient,
      now,
    });
  } catch (err) {
    occupancyError = err?.message || String(err);
  }

  const decision = decideLockoutRecipients(ctx.lockName, guestsByListing, today, hourNy);
  const recipient = decision.recipients[0] || null;
  const firstName = guestFirstName(recipient);
  const proposedResponse = recipient
    ? fillGuestTemplate(firstName, ctx.lockName)
    : fillGuestTemplate('there', ctx.lockName);

  const result = {
    typeOfMessageReceived: 'KEYPAD_LOCKOUT_NOTICE',
    lockName: ctx.lockName,
    lockPhrase,
    lockoutKey: ctx.lockoutKey,
    eventAt: ctx.eventAt,
    simulate: ctx.simulate,
    sendGuests: ctx.sendGuests,
    decision,
    recipient,
    proposedResponse,
    sent: false,
    sendError: occupancyError,
    sendSkipReason: occupancyError ? 'occupancy_lookup_failed' : decision.send ? null : decision.reason,
    occupancyError,
    today,
    hourNy,
  };

  if (occupancyError) {
    await notifyDecision(notifyOwner, {
      simulate: ctx.simulate,
      decision,
      recipient,
      lockName: ctx.lockName,
      proposedResponse,
      sent: false,
      sendError: occupancyError,
    });
    return result;
  }

  if (!decision.send || !recipient) {
    await notifyDecision(notifyOwner, {
      simulate: ctx.simulate,
      decision,
      recipient,
      lockName: ctx.lockName,
      proposedResponse,
      sent: false,
      sendSkipReason: decision.reason,
    });
    return result;
  }

  if (!ctx.sendGuests || ctx.simulate) {
    result.sendSkipReason = ctx.simulate ? 'simulation' : 'send_guests_false';
    await notifyDecision(notifyOwner, {
      simulate: true,
      decision,
      recipient,
      lockName: ctx.lockName,
      proposedResponse,
      sent: false,
      sendSkipReason: result.sendSkipReason,
    });
    return result;
  }

  try {
    const messages = await recentThread(recipient, { hospitableClient, homeExchangeClient });
    if (alreadySentLockoutNotice(messages, lockPhrase)) {
      result.sendSkipReason = 'already_sent';
      await notifyDecision(notifyOwner, {
        simulate: false,
        decision,
        recipient,
        lockName: ctx.lockName,
        proposedResponse,
        sent: false,
        sendSkipReason: 'already_sent',
      });
      return result;
    }
    const sendOut = await sendToRecipient(recipient, proposedResponse, {
      hospitableClient,
      homeExchangeClient,
    });
    result.sent = !!sendOut.sent;
    result.sendError = sendOut.sendError || null;
    result.sendSkipReason = sendOut.sendSkipReason || result.sendSkipReason;
  } catch (err) {
    result.sendError = err?.message || String(err);
  }

  await notifyDecision(notifyOwner, {
    simulate: false,
    decision,
    recipient,
    lockName: ctx.lockName,
    proposedResponse,
    sent: result.sent,
    sendError: result.sendError,
    sendSkipReason: result.sendSkipReason,
  });
  return result;
}

async function notifyDecision(notifyOwner, payload) {
  if (typeof notifyOwner !== 'function') return;
  try {
    await notifyOwner(buildLockoutGuestNotify(payload));
  } catch (err) {
    console.error('[keypadLockoutNotice] owner FCM failed', err?.message || err);
  }
}
