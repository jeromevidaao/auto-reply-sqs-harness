/**
 * Isolated Ring smoke / CO guest notice for Pine Apt #2.
 *
 * cleaningbutton-api ring_smoke_poll enqueues act=ring_smoke_notice on
 * grok_message when a Kidde × Ring detector goes active. This path never
 * goes through Grok. Occupancy comes from Hospitable + HE. Messages every
 * current Apt #2 guest (Airbnb and/or HomeExchange). simulate / sendGuests=false
 * never POSTs to the guest.
 */
import {
  alreadySentSmokeNotice,
  buildSmokeGuestNotify,
  decideSmokeRecipients,
  extractSmokeNoticeContext,
  fillSmokeGuestTemplate,
  guestFirstName,
  isRingSmokeNoticeTurn,
  loadCurrentGuestsByListing,
  nyTodayAndHour,
} from './ringSmokeOccupancy.js';

export { isRingSmokeNoticeTurn, RING_SMOKE_NOTICE_ACT } from './ringSmokeOccupancy.js';

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

export async function handleRingSmokeNotice({
  event,
  hospitableClient = null,
  homeExchangeClient = null,
  notifyOwner = null,
  now = new Date(),
} = {}) {
  const ctx = extractSmokeNoticeContext(event);
  const { today, hourNy } = nyTodayAndHour(now);
  const detectorName = ctx.detectorName || 'a smoke detector';

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

  const decision = decideSmokeRecipients(guestsByListing, today, hourNy);
  const recipients = decision.recipients || [];
  const first = recipients[0] || null;
  const proposedResponse = fillSmokeGuestTemplate(
    guestFirstName(first),
    detectorName,
    ctx.alarmKind
  );

  const result = {
    typeOfMessageReceived: 'RING_SMOKE_NOTICE',
    detectorName,
    detectorKey: ctx.detectorKey,
    detectorId: ctx.detectorId,
    alarmKind: ctx.alarmKind,
    smokeKey: ctx.smokeKey,
    eventAt: ctx.eventAt,
    instruction: ctx.instruction,
    listingId: ctx.listingId,
    simulate: ctx.simulate,
    sendGuests: ctx.sendGuests,
    decision,
    recipient: first,
    recipients,
    proposedResponse,
    sent: false,
    sentCount: 0,
    sendError: occupancyError,
    sendSkipReason: occupancyError
      ? 'occupancy_lookup_failed'
      : decision.send
        ? null
        : decision.reason,
    occupancyError,
    today,
    hourNy,
    deliveries: [],
  };

  if (occupancyError) {
    await notifyDecision(notifyOwner, {
      simulate: ctx.simulate,
      decision,
      recipients,
      detectorName,
      alarmKind: ctx.alarmKind,
      proposedResponse,
      sent: false,
      sendError: occupancyError,
    });
    return result;
  }

  if (!decision.send || !recipients.length) {
    await notifyDecision(notifyOwner, {
      simulate: ctx.simulate,
      decision,
      recipients,
      detectorName,
      alarmKind: ctx.alarmKind,
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
      recipients,
      detectorName,
      alarmKind: ctx.alarmKind,
      proposedResponse,
      sent: false,
      sendSkipReason: result.sendSkipReason,
    });
    return result;
  }

  const deliveries = [];
  const sendErrors = [];
  for (const recipient of recipients) {
    const body = fillSmokeGuestTemplate(
      guestFirstName(recipient),
      detectorName,
      ctx.alarmKind
    );
    try {
      const messages = await recentThread(recipient, {
        hospitableClient,
        homeExchangeClient,
      });
      if (alreadySentSmokeNotice(messages, detectorName)) {
        deliveries.push({
          recipient,
          sent: false,
          sendSkipReason: 'already_sent',
          body,
        });
        continue;
      }
      const sendOut = await sendToRecipient(recipient, body, {
        hospitableClient,
        homeExchangeClient,
      });
      deliveries.push({
        recipient,
        sent: !!sendOut.sent,
        sendError: sendOut.sendError || null,
        sendSkipReason: sendOut.sendSkipReason || null,
        body,
      });
      if (sendOut.sendError) sendErrors.push(sendOut.sendError);
    } catch (err) {
      const msg = err?.message || String(err);
      sendErrors.push(msg);
      deliveries.push({
        recipient,
        sent: false,
        sendError: msg,
        body,
      });
    }
  }

  result.deliveries = deliveries;
  result.sentCount = deliveries.filter((d) => d.sent).length;
  result.sent = result.sentCount > 0;
  result.sendError = sendErrors[0] || null;
  if (!result.sent && !result.sendError) {
    result.sendSkipReason =
      deliveries.find((d) => d.sendSkipReason)?.sendSkipReason || result.sendSkipReason;
  }

  await notifyDecision(notifyOwner, {
    simulate: false,
    decision,
    recipients,
    detectorName,
    alarmKind: ctx.alarmKind,
    proposedResponse,
    sent: result.sent,
    sentCount: result.sentCount,
    sendError: result.sendError,
    sendSkipReason: result.sendSkipReason,
  });
  return result;
}

async function notifyDecision(notifyOwner, payload) {
  if (typeof notifyOwner !== 'function') return;
  try {
    await notifyOwner(buildSmokeGuestNotify(payload));
  } catch (err) {
    console.error('[ringSmokeNotice] owner FCM failed', err?.message || err);
  }
}
