/**
 * Owner Android FCM for HE pre-approve / Hospitable block outcomes.
 * Guest confirmation message is not sent — these notifies are how we validate.
 */
import { clip } from '../adapters/notification/fcm.js';

export const HE_NOTIFY_ERROR = 'homeexchange_preapproval_error';
export const HE_NOTIFY_READY = 'homeexchange_preapproval_ready';
export const HE_NOTIFY_EXPIRED = 'homeexchange_preapproval_expired';

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
  const range = checkIn && checkOut ? `${checkIn} → ${checkOut}` : 'unknown dates';
  const nightList = Array.isArray(nights) && nights.length ? nights.join(', ') : range;

  if (kind === 'ready') {
    return {
      type: HE_NOTIFY_READY,
      title: `HE pre-approved — ${name}`,
      body: clip(
        `Pine #3 ${range}. Hospitable nights blocked (checkout day left open). Guest message NOT sent — validate first.`,
        900
      ),
      data: {
        type: HE_NOTIFY_READY,
        guestName: String(name),
        conversationId: String(conversationId || ''),
        exchangeId: String(exchangeId || ''),
        checkIn: String(checkIn || ''),
        checkOut: String(checkOut || ''),
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
        guestName: String(name),
        conversationId: String(conversationId || ''),
        exchangeId: String(exchangeId || ''),
        checkIn: String(checkIn || ''),
        checkOut: String(checkOut || ''),
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
      guestName: String(name),
      conversationId: String(conversationId || ''),
      exchangeId: String(exchangeId || ''),
      checkIn: String(checkIn || ''),
      checkOut: String(checkOut || ''),
      error: clip(err, 400),
    },
  };
}

export async function notifyHePreapproval(notifyOwner, payload) {
  if (typeof notifyOwner !== 'function') return { ok: false, reason: 'no_notify' };
  const content = buildHePreapprovalNotify(payload);
  return notifyOwner(content);
}
