/**
 * Every 12 hours: if an HE pre-approval expired / was cancelled and the guest
 * never finalized, open the Hospitable nights we blocked.
 *
 * Hospitable GET/PUT and HE conversation already retry 4× (5/15/30s). After
 * those retries a failed unblock is a hard error — Lambda must fail so
 * CloudWatch emails + EventBridge retry.
 */
import { stayNights, dateOnly } from './homeExchange.js';
import { STATUS_FINALIZED, STATUS_EXPIRED_UNBLOCKED } from './homeExchangeBlocks.js';
import { notifyHePreapproval } from './homeExchangeNotify.js';
import { pickExchangeFromConversation } from '../clients/homeExchangeExchange.js';

export const HE_EXPIRE_HARD_FAIL = 'HE_EXPIRE_HARD_FAIL';

export class HomeExchangeExpireError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.name = 'HomeExchangeExpireError';
    this.failures = failures;
  }
}

export function canUnblockCalendarDay(entry) {
  if (!entry) return false;
  const source = String(entry.status?.source_type || entry.source_type || '').toUpperCase();
  if (source === 'RESERVATION') return false;
  if (entry.status && typeof entry.status === 'object') {
    if (String(entry.status.reason || '').toUpperCase() === 'RESERVED') return false;
    return entry.status.available === false;
  }
  if (entry.available === false || entry.blocked === true) return true;
  return false;
}

export function exchangeStillActive(exchange) {
  if (!exchange) return false;
  if (exchange.finalized_at) return true;
  const status = Number(exchange.status);
  // Live inbox: 0 = discussion, 5 = cancelled/expired-ish. Finalized stays set finalized_at.
  if (status === 5) return false;
  return true;
}

export function shouldUnblockPreapproval(record, exchange, now = new Date()) {
  if (!record || record.status !== 'pending_finalization') {
    return { unblock: false, reason: 'not_pending' };
  }
  if (exchange?.finalized_at) {
    return { unblock: false, reason: 'finalized', markFinalized: true };
  }
  const expired = record.expiresAt && String(record.expiresAt) <= now.toISOString();
  const cancelled = exchange && !exchangeStillActive(exchange);
  const approvalCleared = exchange && !exchange.approved_at && !exchange.finalized_at;
  if (expired || cancelled || approvalCleared) {
    return { unblock: true, reason: expired ? 'expired' : cancelled ? 'cancelled' : 'approval_cleared' };
  }
  return { unblock: false, reason: 'still_pending' };
}

function indexCalendarDays(days) {
  const byDate = {};
  for (const day of days || []) {
    const d = dateOnly(day.date || day.day);
    if (d) byDate[d] = day;
  }
  return byDate;
}

export async function unblockHospitableNights({ hospitableClient, record, nights }) {
  if (!hospitableClient?.getPropertyCalendar || !hospitableClient?.updatePropertyCalendar) {
    const err = new Error('Hospitable calendar client missing');
    err.permanent = true;
    throw err;
  }
  if (!record.propertyId) {
    const err = new Error('propertyId missing on preapproval block record');
    err.permanent = true;
    throw err;
  }
  if (!nights.length) {
    return { unblocked: [], skipped: [] };
  }

  const start = nights[0];
  const end = dateOnly(record.checkOut) || nights[nights.length - 1];
  const days = await hospitableClient.getPropertyCalendar(record.propertyId, start, end);
  if (!Array.isArray(days) || days.length === 0) {
    throw new Error('hospitable calendar empty for expire window');
  }

  const byDate = indexCalendarDays(days);
  const toOpen = [];
  const unblocked = [];
  const skipped = [];
  for (const night of nights) {
    if (canUnblockCalendarDay(byDate[night])) {
      toOpen.push({ date: night, available: true });
      unblocked.push(night);
    } else {
      skipped.push(night);
    }
  }

  if (toOpen.length) {
    try {
      await hospitableClient.updatePropertyCalendar(record.propertyId, toOpen);
    } catch (err) {
      let recovered = false;
      try {
        const again = await hospitableClient.getPropertyCalendar(record.propertyId, start, end);
        const byDate2 = indexCalendarDays(again);
        const stillBlocked = toOpen.filter((d) => canUnblockCalendarDay(byDate2[d.date]));
        recovered = stillBlocked.length === 0;
      } catch (fetchErr) {
        console.warn(
          '[HomeExchangeExpire] post-PUT calendar check failed:',
          fetchErr?.message || fetchErr
        );
      }
      if (!recovered) throw err;
      console.warn(
        '[HomeExchangeExpire] calendar PUT failed but nights are already open — treating as unblocked'
      );
    }
  }
  return { unblocked, skipped };
}

export async function expireHomeExchangeBlocks({
  homeExchangeClient = null,
  hospitableClient = null,
  blockStore = null,
  notifyOwner = null,
  now = new Date(),
} = {}) {
  if (!blockStore || typeof blockStore.scanPending !== 'function') {
    throw new HomeExchangeExpireError(`${HE_EXPIRE_HARD_FAIL}: no_block_store`, [
      { ok: false, reason: 'no_block_store' },
    ]);
  }

  const pending = await blockStore.scanPending();
  const results = [];

  for (const record of pending) {
    let exchange = null;
    try {
      if (record.conversationId && homeExchangeClient?.getConversation) {
        const conv = await homeExchangeClient.getConversation(record.conversationId);
        exchange = pickExchangeFromConversation(conv, record.homeId);
      }
    } catch (err) {
      results.push({
        exchangeId: record.exchangeId,
        ok: false,
        reason: 'he_fetch_failed',
        error: err?.message || String(err),
      });
      continue;
    }

    const decision = shouldUnblockPreapproval(record, exchange, now);
    if (decision.markFinalized) {
      await blockStore.updateStatus(record.exchangeId, STATUS_FINALIZED, {
        finalizedAt: String(exchange.finalized_at),
      });
      results.push({ exchangeId: record.exchangeId, ok: true, reason: 'finalized' });
      continue;
    }
    if (!decision.unblock) {
      results.push({ exchangeId: record.exchangeId, ok: true, reason: decision.reason });
      continue;
    }

    const nights = Array.isArray(record.nights) && record.nights.length
      ? record.nights
      : stayNights(record.checkIn, record.checkOut);

    let unblocked = [];
    let skipped = [];
    try {
      const opened = await unblockHospitableNights({ hospitableClient, record, nights });
      unblocked = opened.unblocked;
      skipped = opened.skipped;
    } catch (err) {
      results.push({
        exchangeId: record.exchangeId,
        ok: false,
        reason: 'hospitable_unblock_failed',
        error: err?.message || String(err),
      });
      try {
        await notifyHePreapproval(notifyOwner, {
          kind: 'error',
          guestName: record.guestName,
          checkIn: record.checkIn,
          checkOut: record.checkOut,
          conversationId: record.conversationId,
          exchangeId: record.exchangeId,
          error: `Expire unblock failed after retries: ${err?.message || err}`,
        });
      } catch (notifyErr) {
        console.error('[HomeExchangeExpire] FCM error notify failed', notifyErr?.message || notifyErr);
      }
      continue;
    }

    await blockStore.updateStatus(record.exchangeId, STATUS_EXPIRED_UNBLOCKED, {
      unblockedAt: now.toISOString(),
      expireReason: decision.reason,
    });
    try {
      await notifyHePreapproval(notifyOwner, {
        kind: 'expired_unblocked',
        guestName: record.guestName,
        checkIn: record.checkIn,
        checkOut: record.checkOut,
        conversationId: record.conversationId,
        exchangeId: record.exchangeId,
        nights: unblocked,
      });
    } catch (notifyErr) {
      console.error('[HomeExchangeExpire] FCM ready notify failed', notifyErr?.message || notifyErr);
    }
    results.push({
      exchangeId: record.exchangeId,
      ok: true,
      reason: decision.reason,
      unblocked,
      skipped,
    });
  }

  const failures = results.filter((r) => r.ok === false);
  if (failures.length) {
    const summary = failures
      .map((f) => `${f.exchangeId || '?'}:${f.reason}${f.error ? ` (${f.error})` : ''}`)
      .join('; ');
    const err = new HomeExchangeExpireError(
      `${HE_EXPIRE_HARD_FAIL}: ${failures.length} record(s) failed after retries: ${summary}`,
      failures
    );
    console.error(err.message);
    throw err;
  }

  return { ok: true, processed: pending.length, results };
}
