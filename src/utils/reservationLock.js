/**
 * Per-reservation in-Lambda mutex (Michael 2026-08-21 Hospitable 429 stampede;
 * Carlos 2026-08-28 double you're-welcome).
 *
 * grok_message is a standard queue (not FIFO). Rapid guest messages start
 * concurrent Lambdas on the same reservation.
 *
 * Do not wait for the holder. The in-flight invoke GETs the live thread
 * before POST and folds newer guest turns into one reply. A sibling on the
 * same reservation/conversation returns 200 so SQS deletes that message
 * instead of drafting a second send. Parallel invokes on *different*
 * reservations are fine.
 *
 * Lock lives on airbnb-harness-dedup (existing PutItem/GetItem IAM) under
 * webhookId = lock:resv:{id} or lock:conv:{id}. TTL must outlast the Lambda
 * timeout (360s) so a still-running holder is not stolen.
 */
import { PutCommand } from '@aws-sdk/lib-dynamodb';

export const RESERVATION_LOCK_TABLE = 'airbnb-harness-dedup';
export const RESERVATION_LOCK_TTL_SEC = 420;
/** Default: do not wait. A held lock means drop this SQS message. */
export const RESERVATION_LOCK_WAIT_MS = 0;
export const RESERVATION_LOCK_POLL_MS = 2000;

export function lockKeyFor({ reservationId, conversationId } = {}) {
  const res = reservationId && String(reservationId).trim();
  if (res) return `lock:resv:${res}`;
  const conv = conversationId && String(conversationId).trim();
  if (conv) return `lock:conv:${conv}`;
  return null;
}

/**
 * True when another invoke already holds this reservation/conversation.
 * Caller must return 200 (delete SQS) and not draft/send.
 * Missing DDB / missing id (`skipped`) still proceeds.
 */
export function isSameConversationInFlight(lock) {
  return Boolean(lock && lock.acquired !== true && lock.skipped !== true);
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

  const deadline = now + Math.max(0, waitMs);
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
    if (waitMs <= 0 || clock() >= deadline) {
      return {
        acquired: false,
        key,
        waitedMs,
        reason: waitedMs > 0 ? 'timeout' : 'held',
        attempts: attempt,
      };
    }
    const remaining = deadline - clock();
    const sleepFor = Math.min(pollMs, Math.max(1, remaining));
    await sleeper(sleepFor);
    waitedMs += sleepFor;
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
