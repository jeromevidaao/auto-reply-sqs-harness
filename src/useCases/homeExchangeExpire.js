/**
 * Every 12 hours: if an HE pre-approval expired / was cancelled and the guest
 * never finalized, open the Hospitable nights we blocked.
 */
import { stayNights, dateOnly } from './homeExchange.js';
import { STATUS_FINALIZED, STATUS_EXPIRED_UNBLOCKED } from './homeExchangeBlocks.js';
import { notifyHePreapproval } from './homeExchangeNotify.js';
import { pickExchangeFromConversation } from '../clients/homeExchangeExchange.js';

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

export async function expireHomeExchangeBlocks({
  homeExchangeClient = null,
  hospitableClient = null,
  blockStore = null,
  notifyOwner = null,
  now = new Date(),
} = {}) {
  if (!blockStore || typeof blockStore.scanPending !== 'function') {
    return { ok: false, reason: 'no_block_store', processed: 0 };
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
    const unblocked = [];
    const skipped = [];
    try {
      if (hospitableClient?.getPropertyCalendar && hospitableClient?.updatePropertyCalendar && record.propertyId) {
        const start = nights[0];
        const end = dateOnly(record.checkOut) || nights[nights.length - 1];
        const days = await hospitableClient.getPropertyCalendar(record.propertyId, start, end);
        const byDate = {};
        for (const day of days || []) {
          const d = dateOnly(day.date || day.day);
          if (d) byDate[d] = day;
        }
        const toOpen = [];
        for (const night of nights) {
          if (canUnblockCalendarDay(byDate[night])) {
            toOpen.push({ date: night, available: true });
            unblocked.push(night);
          } else {
            skipped.push(night);
          }
        }
        // available:true for nights we ourselves blocked
        if (toOpen.length) {
          await hospitableClient.updatePropertyCalendar(
            record.propertyId,
            toOpen.map((d) => ({ date: d.date, available: true }))
          );
        }
      }
    } catch (err) {
      results.push({
        exchangeId: record.exchangeId,
        ok: false,
        reason: 'hospitable_unblock_failed',
        error: err?.message || String(err),
      });
      await notifyHePreapproval(notifyOwner, {
        kind: 'error',
        guestName: record.guestName,
        checkIn: record.checkIn,
        checkOut: record.checkOut,
        conversationId: record.conversationId,
        exchangeId: record.exchangeId,
        error: `Expire unblock failed: ${err?.message || err}`,
      });
      continue;
    }

    await blockStore.updateStatus(record.exchangeId, STATUS_EXPIRED_UNBLOCKED, {
      unblockedAt: now.toISOString(),
      expireReason: decision.reason,
    });
    await notifyHePreapproval(notifyOwner, {
      kind: 'expired_unblocked',
      guestName: record.guestName,
      checkIn: record.checkIn,
      checkOut: record.checkOut,
      conversationId: record.conversationId,
      exchangeId: record.exchangeId,
      nights: unblocked,
    });
    results.push({
      exchangeId: record.exchangeId,
      ok: true,
      reason: decision.reason,
      unblocked,
      skipped,
    });
  }

  return { ok: true, processed: pending.length, results };
}
