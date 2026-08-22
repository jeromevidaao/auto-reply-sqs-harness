/**
 * Per-reservation in-Lambda mutex (Michael 2026-08-21 Hospitable 429 stampede).
 *
 * grok_message is a standard queue (not FIFO). Rapid guest messages start
 * concurrent Lambdas on the same reservation; each GET/POST
 * /reservations/{id}/messages hits Hospitable's ~2/min cap.
 *
 * Lock lives on airbnb-harness-dedup (existing PutItem/GetItem IAM) under
 * webhookId = lock:resv:{id}. Waiters poll with conditional Put until the
 * holder releases or expiresAt passes. Timeout → proceed anyway so a crash
 * cannot stall the guest.
 */
import { PutCommand } from '@aws-sdk/lib-dynamodb';

export const RESERVATION_LOCK_TABLE = 'airbnb-harness-dedup';
export const RESERVATION_LOCK_TTL_SEC = 180;
export const RESERVATION_LOCK_WAIT_MS = 90_000;
export const RESERVATION_LOCK_POLL_MS = 2000;

export function lockKeyFor({ reservationId, conversationId } = {}) {
  const res = reservationId && String(reservationId).trim();
  if (res) return `lock:resv:${res}`;
  const conv = conversationId && String(conversationId).trim();
  if (conv) return `lock:conv:${conv}`;
  return null;
}

function nowSec(ms) {
  return Math.floor(ms / 1000);
}

/**
 * @returns {Promise<{ acquired: boolean, skipped?: boolean, key?: string, waitedMs: number, reason?: string }>}
 */
export async function acquireReservationLock({
  ddb,
  reservationId,
  conversationId,
  holder,
  now = Date.now(),
  clock = Date.now,
  sleeper = (ms) => new Promise((r) => setTimeout(r, ms)),
  waitMs = RESERVATION_LOCK_WAIT_MS,
  pollMs = RESERVATION_LOCK_POLL_MS,
  ttlSec = RESERVATION_LOCK_TTL_SEC,
  tableName = RESERVATION_LOCK_TABLE,
} = {}) {
  const key = lockKeyFor({ reservationId, conversationId });
  if (!ddb || typeof ddb.send !== 'function') {
    return { acquired: false, skipped: true, waitedMs: 0, reason: 'no_ddb' };
  }
  if (!key) {
    return { acquired: false, skipped: true, waitedMs: 0, reason: 'no_id' };
  }
  if (!holder) {
    return { acquired: false, skipped: true, key, waitedMs: 0, reason: 'no_holder' };
  }

  const deadline = now + waitMs;
  let waitedMs = 0;
  let attempt = 0;

  while (true) {
    const t = clock();
    const expiresAt = nowSec(t) + ttlSec;
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            webhookId: key,
            holder: String(holder),
            kind: 'reservation-lock',
            released: false,
            expiresAt,
            ttl: expiresAt,
            acquiredAt: new Date(t).toISOString(),
          },
          ConditionExpression:
            'attribute_not_exists(webhookId) OR expiresAt < :now OR released = :t',
          ExpressionAttributeValues: {
            ':now': nowSec(t),
            ':t': true,
          },
        })
      );
      return { acquired: true, key, waitedMs, attempts: attempt + 1 };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') {
        console.warn('[reservationLock] acquire non-fatal:', err?.message || err);
        return { acquired: false, skipped: true, key, waitedMs, reason: 'ddb_error' };
      }
    }

    attempt += 1;
    if (clock() + pollMs > deadline) {
      return { acquired: false, key, waitedMs, reason: 'timeout', attempts: attempt };
    }
    await sleeper(pollMs);
    waitedMs += pollMs;
  }
}

export async function releaseReservationLock({
  ddb,
  key,
  holder,
  now = Date.now(),
  tableName = RESERVATION_LOCK_TABLE,
} = {}) {
  if (!ddb || !key || !holder) return { released: false, reason: 'missing_args' };
  const expiresAt = nowSec(now);
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          webhookId: key,
          holder: String(holder),
          kind: 'reservation-lock',
          released: true,
          expiresAt,
          ttl: expiresAt + 3600,
          releasedAt: new Date(now).toISOString(),
        },
        ConditionExpression: 'holder = :me',
        ExpressionAttributeValues: { ':me': String(holder) },
      })
    );
    return { released: true, key };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { released: false, key, reason: 'not_holder' };
    }
    console.warn('[reservationLock] release non-fatal:', err?.message || err);
    return { released: false, key, reason: 'ddb_error' };
  }
}
