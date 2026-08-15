/**
 * Owner Android FCM for the isolated HE auto-reply path.
 * Airbnb / Hospitable auto-replies do not use this — HE is new and we want
 * a phone trail of every pre-approve and every guest message we send.
 */
import { clip } from '../adapters/notification/fcm.js';

export const HE_NOTIFY_ERROR = 'homeexchange_preapproval_error';
export const HE_NOTIFY_READY = 'homeexchange_preapproval_ready';
export const HE_NOTIFY_EXPIRED = 'homeexchange_preapproval_expired';
export const HE_NOTIFY_SENT = 'homeexchange_auto_reply_sent';
export const HE_NOTIFY_SEND_FAILED = 'homeexchange_auto_reply_failed';

function heRange(checkIn, checkOut) {
  return checkIn && checkOut ? `${checkIn} → ${checkOut}` : 'unknown dates';
}

function heBaseData({ guestName, conversationId, exchangeId, checkIn, checkOut }) {
  const name = guestName || 'Guest';
  return {
    guestName: String(name),
    peerName: String(name),
    conversationId: String(conversationId || ''),
    exchangeId: String(exchangeId || ''),
    checkIn: String(checkIn || ''),
    checkOut: String(checkOut || ''),
  };
}

export function buildHePreapprovalNotify({
  kind,
  guestName,
  checkIn,
  checkOut,
  conversationId,
  exchangeId,
  error,
  nights,
} = {}) {
  const name = guestName || 'Guest';
  const range = heRange(checkIn, checkOut);
  const nightList = Array.isArray(nights) && nights.length ? nights.join(', ') : range;
  const base = heBaseData({ guestName: name, conversationId, exchangeId, checkIn, checkOut });

  if (kind === 'ready') {
    return {
      type: HE_NOTIFY_READY,
      title: `HE pre-approved — ${name}`,
      body: clip(
        `Pine #3 ${range}. Pre-approved on Home Exchange. Hospitable nights blocked (checkout day left open).`,
        900
      ),
      data: {
        type: HE_NOTIFY_READY,
        ...base,
        nights: clip(nightList, 400),
      },
    };
  }

  if (kind === 'expired_unblocked') {
    return {
      type: HE_NOTIFY_EXPIRED,
      title: `HE pre-approval expired — ${name}`,
      body: clip(`Unblocked Hospitable nights for ${range}. Guest did not finalize.`, 900),
      data: {
        type: HE_NOTIFY_EXPIRED,
        ...base,
      },
    };
  }

  const err = error || 'unknown error';
  return {
    type: HE_NOTIFY_ERROR,
    title: `HE pre-approve stopped — ${name}`,
    body: clip(`${range}. Did not proceed. ${err}`, 900),
    data: {
      type: HE_NOTIFY_ERROR,
      ...base,
      error: clip(err, 400),
    },
  };
}

export function buildHeAutoReplyNotify({
  kind,
  guestName,
  checkIn,
  checkOut,
  conversationId,
  exchangeId,
  proposedResponse,
  reason,
  preapproved,
  error,
} = {}) {
  const name = guestName || 'Guest';
  const range = heRange(checkIn, checkOut);
  const base = heBaseData({ guestName: name, conversationId, exchangeId, checkIn, checkOut });
  const reasonBit = reason ? ` (${reason})` : '';

  if (kind === 'send_failed') {
    const err = error || 'unknown error';
    return {
      type: HE_NOTIFY_SEND_FAILED,
      title: `HE auto-reply failed — ${name}`,
      body: clip(`${range}. Guest message not sent${reasonBit}. ${err}`, 900),
      data: {
        type: HE_NOTIFY_SEND_FAILED,
        ...base,
        reason: clip(reason || '', 200),
        error: clip(err, 400),
      },
    };
  }

  const prefix = preapproved ? 'Pre-approval note sent. ' : 'Auto-reply sent. ';
  return {
    type: HE_NOTIFY_SENT,
    title: `HE auto-reply sent — ${name}`,
    body: clip(`${prefix}${range}${reasonBit}.\n\n${proposedResponse || ''}`, 900),
    data: {
      type: HE_NOTIFY_SENT,
      ...base,
      reason: clip(reason || '', 200),
      proposedResponse: clip(proposedResponse || '', 1800),
    },
  };
}

export async function notifyHePreapproval(notifyOwner, payload) {
  if (typeof notifyOwner !== 'function') return { ok: false, reason: 'no_notify' };
  return notifyOwner(buildHePreapprovalNotify(payload));
}

export async function notifyHeAutoReply(notifyOwner, payload) {
  if (typeof notifyOwner !== 'function') return { ok: false, reason: 'no_notify' };
  return notifyOwner(buildHeAutoReplyNotify(payload));
}
