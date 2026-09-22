/**
 * Isolated unit-ready / early check-in guest notice.
 *
 * Producers on grok_message act=early_checkin_notice:
 *   - cleaningToRegister (action=cleaning.unit_ready)
 *   - noon Lambda (action=noon.vacant_unit_ready) — skip if checkout today
 *     (Airbnb or HE) or listing still in uncleanedUnits
 *
 * Never goes through Grok. Occupancy from Hospitable + HE. Messages the guest
 * checking in today on that listing (Airbnb and/or HomeExchange). Send window
 * is 8:00 AM through just before 4:00 PM America/New_York. simulate /
 * sendGuests=false never POSTs to the guest.
 */
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  alreadyHandledEarlyCheckinOnThread,
  alreadySentUnitReadyNotice,
  buildEarlyCheckinGuestNotify,
  CLEANING_TABLE,
  decideUnitReadyRecipients,
  extractEarlyCheckinNoticeContext,
  fillUnitReadyTemplate,
  guestFirstName,
  isEarlyCheckinNoticeTurn,
  isWithinUnitReadySendWindow,
  loadCurrentGuestsByListing,
  nyClock,
  nyTodayAndHour,
  UNCLEANED_TABLE,
  UNIT_BY_LISTING,
  unitReadySkipReason,
} from './earlyCheckinOccupancy.js';

export { isEarlyCheckinNoticeTurn, EARLY_CHECKIN_NOTICE_ACT } from './earlyCheckinOccupancy.js';

/**
 * True when Dynamo uncleanedUnits still has this listing as needed.
 * Fail closed: lookup errors throw so we never send "unit is ready" blindly.
 */
export async function isUnitStillUncleaned({ ddbClient = null, listingId } = {}) {
  const lid = String(listingId || '').trim();
  if (!lid) return false;
  if (!ddbClient) {
    throw new Error('uncleaned_lookup_unavailable');
  }
  const data = await ddbClient.send(
    new GetCommand({
      TableName: UNCLEANED_TABLE,
      Key: { listingId: lid },
    })
  );
  const item = data && data.Item;
  if (!item) return false;
  if (item.needed === false) return false;
  return true;
}

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

/**
 * Persist early-check-in send on the same-day cleaning row so the Android unit
 * page can show: "Early check-in sent to [name] · X mins ago".
 * Non-fatal — messaging success must not fail if the write fails.
 */
export async function recordEarlyCheckinOnCleaning({
  ddbClient = null,
  listingId,
  today,
  recipient,
  firstName,
} = {}) {
  const lid = String(listingId || '').trim();
  const day = String(today || '').trim();
  if (!ddbClient || !lid || !day) return { recorded: false, reason: 'missing_key' };
  const key = `${lid}_${day}`;
  const fullName =
    [recipient?.guestName, firstName].filter(Boolean)[0] ||
    guestFirstName(recipient) ||
    'Guest';
  const sentAt = new Date().toISOString();
  const reservationId = recipient?.reservationId ? String(recipient.reservationId) : '';
  try {
    await ddbClient.send(
      new UpdateCommand({
        TableName: CLEANING_TABLE,
        Key: { listingIdAndDate: key },
        UpdateExpression:
          'SET earlyCheckinSentAt = :at, earlyCheckinGuestName = :gn, earlyCheckinReservationId = :rid',
        ExpressionAttributeValues: {
          ':at': sentAt,
          ':gn': fullName,
          ':rid': reservationId,
        },
      })
    );
    return { recorded: true, key, sentAt };
  } catch (err) {
    console.error(
      '[earlyCheckinNotice] Failed to record on cleaning',
      key,
      err?.message || err
    );
    return { recorded: false, reason: err?.message || String(err) };
  }
}

export async function handleEarlyCheckinNotice({
  event,
  hospitableClient = null,
  homeExchangeClient = null,
  notifyOwner = null,
  ddbClient = null,
  now = new Date(),
} = {}) {
  const ctx = extractEarlyCheckinNoticeContext(event);
  const clock = nyClock(now);
  const { today } = nyTodayAndHour(now);
  const listingId = ctx.listingId;
  const cleaningDate = ctx.date || today;
  const windowReason = unitReadySkipReason(now);

  const result = {
    typeOfMessageReceived: 'EARLY_CHECKIN_NOTICE',
    listingId,
    listingName: ctx.listingName || UNIT_BY_LISTING[listingId]?.propertyName || '',
    date: cleaningDate,
    eventAt: ctx.eventAt,
    instruction: ctx.instruction,
    simulate: ctx.simulate,
    sendGuests: ctx.sendGuests,
    decision: { send: false, reason: windowReason || 'pending', recipients: [] },
    recipient: null,
    recipients: [],
    proposedResponse: fillUnitReadyTemplate('there'),
    sent: false,
    sentCount: 0,
    sendError: null,
    sendSkipReason: windowReason,
    occupancyError: null,
    source: ctx.source,
    requireVacantOvernight: ctx.requireVacantOvernight,
    today,
    hourNy: clock.hourNy,
    minuteNy: clock.minuteNy,
    withinWindow: isWithinUnitReadySendWindow(now),
    deliveries: [],
  };

  if (windowReason) {
    result.decision = { send: false, reason: windowReason, recipients: [] };
    await notifyDecision(notifyOwner, {
      simulate: ctx.simulate,
      decision: result.decision,
      recipients: [],
      listingId,
      listingName: result.listingName,
      proposedResponse: result.proposedResponse,
      sent: false,
      sendSkipReason: windowReason,
    });
    return result;
  }

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

  if (occupancyError) {
    result.occupancyError = occupancyError;
    result.sendError = occupancyError;
    result.sendSkipReason = 'occupancy_lookup_failed';
    await notifyDecision(notifyOwner, {
      simulate: ctx.simulate,
      decision: result.decision,
      recipients: [],
      listingId,
      listingName: result.listingName,
      proposedResponse: result.proposedResponse,
      sent: false,
      sendError: occupancyError,
    });
    return result;
  }

  let uncleaned = false;
  if (ctx.requireVacantOvernight) {
    try {
      uncleaned = await isUnitStillUncleaned({ ddbClient, listingId });
    } catch (err) {
      const msg = err?.message || String(err);
      result.occupancyError = msg;
      result.sendError = msg;
      result.sendSkipReason = 'uncleaned_lookup_failed';
      await notifyDecision(notifyOwner, {
        simulate: ctx.simulate,
        decision: result.decision,
        recipients: [],
        listingId,
        listingName: result.listingName,
        proposedResponse: result.proposedResponse,
        sent: false,
        sendError: msg,
      });
      return result;
    }
  }

  const decision = decideUnitReadyRecipients(listingId, guestsByListing, today, now, {
    requireVacantOvernight: ctx.requireVacantOvernight,
    uncleaned,
  });
  const recipients = decision.recipients || [];
  const first = recipients[0] || null;
  result.decision = decision;
  result.recipients = recipients;
  result.recipient = first;
  result.proposedResponse = fillUnitReadyTemplate(guestFirstName(first));
  result.sendSkipReason = decision.send ? null : decision.reason;

  // Noon on an empty unit is a no-op every day — do not ping Android.
  if (
    ctx.requireVacantOvernight &&
    !decision.send &&
    decision.reason === 'no_checkin_today'
  ) {
    return result;
  }

  if (!decision.send || !recipients.length) {
    await notifyDecision(notifyOwner, {
      simulate: ctx.simulate,
      decision,
      recipients,
      listingId,
      listingName: result.listingName,
      proposedResponse: result.proposedResponse,
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
      listingId,
      listingName: result.listingName,
      proposedResponse: result.proposedResponse,
      sent: false,
      sendSkipReason: result.sendSkipReason,
    });
    return result;
  }

  const deliveries = [];
  const sendErrors = [];
  for (const recipient of recipients) {
    const body = fillUnitReadyTemplate(guestFirstName(recipient));
    try {
      const messages = await recentThread(recipient, {
        hospitableClient,
        homeExchangeClient,
      });
      // Dedup: unit-ready OR prior reactive early-checkin reply (one msg max).
      if (alreadyHandledEarlyCheckinOnThread(messages)) {
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
      if (sendOut.sent) {
        await recordEarlyCheckinOnCleaning({
          ddbClient,
          listingId: recipient.listingId || listingId,
          today: cleaningDate,
          recipient,
          firstName: guestFirstName(recipient),
        });
      }
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
    listingId,
    listingName: result.listingName,
    proposedResponse: result.proposedResponse,
    sent: result.sent,
    sentCount: result.sentCount,
    sendError: result.sendError,
    sendSkipReason: result.sendSkipReason,
  });
  return result;
}

async function notifyDecision(notifyOwner, payload) {
  if (typeof notifyOwner !== 'function') return;
  const notice = buildEarlyCheckinGuestNotify(payload);
  if (!notice) return;
  try {
    await notifyOwner(notice);
  } catch (err) {
    console.error('[earlyCheckinNotice] owner FCM failed', err?.message || err);
  }
}
