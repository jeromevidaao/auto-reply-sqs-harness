import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HospitableClient } from '../src/clients/HospitableClient.js';
import {
  GROK_MESSAGE_MAX_RECEIVE_COUNT,
  GROK_MESSAGE_VISIBILITY_TIMEOUT_SEC,
  HOSPITABLE_429_DEFAULT_MS,
  HOSPITABLE_READ_429_MIN_MS,
  HOSPITABLE_SEND_MAX_ATTEMPTS,
  HOSPITABLE_SEND_MIN_INTERVAL_MS,
  computeRetryDelay,
  hostAlreadySentEquivalent,
  isTransientHttpError,
  looksLikeExistingWelcome,
  parseRetryAfterMs,
  withExponentialBackoff,
} from '../src/utils/httpRetry.js';

function timeoutErr(ms = 15000) {
  const err = new Error(`timeout of ${ms}ms exceeded`);
  err.code = 'ECONNABORTED';
  return err;
}

function statusErr(status, message = `Request failed with status code ${status}`) {
  const err = new Error(message);
  err.response = { status };
  return err;
}

describe('isTransientHttpError', () => {
  it('treats timeouts, 429, 5xx, and network codes as transient', () => {
    assert.equal(isTransientHttpError(timeoutErr()), true);
    assert.equal(isTransientHttpError(statusErr(429)), true);
    assert.equal(isTransientHttpError(statusErr(503)), true);
    assert.equal(isTransientHttpError(statusErr(408)), true);
    const reset = new Error('socket hang up');
    reset.code = 'ECONNRESET';
    assert.equal(isTransientHttpError(reset), true);
  });

  it('does not retry permanent 4xx (except 408/429)', () => {
    assert.equal(isTransientHttpError(statusErr(400)), false);
    assert.equal(isTransientHttpError(statusErr(401)), false);
    assert.equal(isTransientHttpError(statusErr(403)), false);
    assert.equal(isTransientHttpError(statusErr(404)), false);
  });
});

describe('computeRetryDelay / Retry-After', () => {
  it('spaces send retries at least 30s (Hospitable 2 POSTs/min/reservation)', () => {
    const delay = computeRetryDelay(timeoutErr(), { attempt: 1, kind: 'send', jitter: false });
    assert.ok(delay >= HOSPITABLE_SEND_MIN_INTERVAL_MS, `got ${delay}`);
    assert.equal(delay, 30000);
  });

  it('uses 4 in-Lambda send attempts and 4 SQS receives / 12 min visibility', () => {
    assert.equal(HOSPITABLE_SEND_MAX_ATTEMPTS, 4);
    assert.equal(GROK_MESSAGE_MAX_RECEIVE_COUNT, 4);
    assert.equal(GROK_MESSAGE_VISIBILITY_TIMEOUT_SEC, 720);
  });

  it('send backoff stays inside a ~3 min in-Lambda window (4x20s + 30+30+40)', () => {
    const waits = [1, 2, 3].map((attempt) =>
      computeRetryDelay(timeoutErr(20000), { attempt, kind: 'send', jitter: false })
    );
    assert.deepEqual(waits, [30000, 30000, 40000]);
    const worstCaseMs = 4 * 20000 + waits.reduce((a, b) => a + b, 0);
    assert.ok(worstCaseMs <= 3.5 * 60 * 1000, `worst-case ${worstCaseMs}ms`);
    assert.ok(worstCaseMs >= 2 * 60 * 1000, `worst-case ${worstCaseMs}ms`);
  });

  it('uses 60s default on 429 when Retry-After is absent', () => {
    const delay = computeRetryDelay(statusErr(429), { attempt: 3, kind: 'send', jitter: false });
    assert.ok(delay >= HOSPITABLE_429_DEFAULT_MS, `got ${delay}`);
  });

  it('honors Retry-After seconds', () => {
    const err = statusErr(429);
    err.response.headers = { 'retry-after': '90' };
    assert.equal(parseRetryAfterMs(err), 90000);
    const delay = computeRetryDelay(err, { attempt: 1, kind: 'send', jitter: false });
    assert.ok(delay >= 90000, `got ${delay}`);
  });

  it('does not honor Retry-After: 0 (Amber 2026-08-17 — burned 4 GETs in 29s)', () => {
    const err = statusErr(429);
    err.response.headers = { 'retry-after': '0' };
    assert.equal(parseRetryAfterMs(err), 0);
    const readDelay = computeRetryDelay(err, { attempt: 2, kind: 'read', jitter: false });
    const sendDelay = computeRetryDelay(err, { attempt: 2, kind: 'send', jitter: false });
    assert.ok(readDelay >= HOSPITABLE_429_DEFAULT_MS, `read delay ${readDelay}`);
    assert.ok(sendDelay >= HOSPITABLE_429_DEFAULT_MS, `send delay ${sendDelay}`);
    assert.ok(readDelay >= HOSPITABLE_READ_429_MIN_MS);
  });

  it('does not honor a past Retry-After HTTP-date', () => {
    const err = statusErr(429);
    err.response.headers = { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' };
    assert.equal(parseRetryAfterMs(err), 0);
    const delay = computeRetryDelay(err, { attempt: 3, kind: 'read', jitter: false });
    assert.ok(delay >= HOSPITABLE_429_DEFAULT_MS, `got ${delay}`);
  });

  it('floors tiny Retry-After on reads to the 15s minimum via 60s fallback', () => {
    const err = statusErr(429);
    err.response.headers = { 'retry-after': '2' };
    const delay = computeRetryDelay(err, { attempt: 1, kind: 'read', jitter: false });
    assert.ok(delay >= HOSPITABLE_429_DEFAULT_MS, `got ${delay}`);
  });

  it('uses shorter exponential backoff for reads', () => {
    const d1 = computeRetryDelay(timeoutErr(), { attempt: 1, kind: 'read', jitter: false });
    const d2 = computeRetryDelay(timeoutErr(), { attempt: 2, kind: 'read', jitter: false });
    assert.equal(d1, 2000);
    assert.equal(d2, 4000);
  });

  it('uses 5/15/30s write backoff (HE + calendar PUT, ~1 min)', () => {
    const waits = [1, 2, 3].map((attempt) =>
      computeRetryDelay(timeoutErr(), { attempt, kind: 'write', jitter: false })
    );
    assert.deepEqual(waits, [5000, 15000, 30000]);
  });
});

describe('withExponentialBackoff', () => {
  it('retries transient send failures with exp backoff then succeeds', async () => {
    const delays = [];
    let n = 0;
    const out = await withExponentialBackoff(
      async () => {
        n += 1;
        if (n === 1) throw timeoutErr(30000);
        if (n === 2) throw statusErr(429);
        return { ok: true, n };
      },
      {
        operation: 'sendMessageToReservation',
        kind: 'send',
        jitter: false,
        sleeper: async (ms) => {
          delays.push(ms);
        },
        recover: async () => false,
      }
    );
    assert.deepEqual(out, { ok: true, n: 3 });
    assert.equal(delays.length, 2);
    assert.ok(delays[0] >= HOSPITABLE_SEND_MIN_INTERVAL_MS, `timeout backoff ${delays[0]}`);
    assert.ok(delays[1] >= HOSPITABLE_429_DEFAULT_MS, `429 backoff ${delays[1]}`);
  });

  it('never sleeps 0ms on Retry-After: 0', async () => {
    const delays = [];
    let n = 0;
    const err = statusErr(429);
    err.response.headers = { 'retry-after': '0' };
    const out = await withExponentialBackoff(
      async () => {
        n += 1;
        if (n < 3) throw err;
        return { ok: true };
      },
      {
        operation: 'getReservationMessages',
        kind: 'read',
        jitter: false,
        sleeper: async (ms) => {
          delays.push(ms);
        },
      }
    );
    assert.deepEqual(out, { ok: true });
    assert.equal(delays.length, 2);
    for (const d of delays) {
      assert.ok(d >= HOSPITABLE_READ_429_MIN_MS, `slept ${d}ms`);
    }
  });

  it('does not retry 404', async () => {
    await assert.rejects(
      () =>
        withExponentialBackoff(
          async () => {
            throw statusErr(404);
          },
          { operation: 'getReservationMessages', kind: 'read', sleeper: async () => {} }
        ),
      /failed after 1 attempt/
    );
  });

  it('recover after timeout treats send as delivered (no extra POST)', async () => {
    let posts = 0;
    const body = 'Good afternoon, Julie, welcome — thanks for booking! Check-in is at 4pm with self-check-in.';
    const out = await withExponentialBackoff(
      async () => {
        posts += 1;
        throw timeoutErr(30000);
      },
      {
        operation: 'sendMessageToReservation',
        kind: 'send',
        recover: async () => ({ alreadyDelivered: true, body }),
        sleeper: async () => {
          throw new Error('should not sleep when recover succeeds');
        },
      }
    );
    assert.equal(posts, 1);
    assert.equal(out.alreadyDelivered, true);
  });
});

describe('hostAlreadySentEquivalent / looksLikeExistingWelcome', () => {
  const welcome =
    'Good afternoon, Julie, welcome — thanks for booking with us! Check-in is at 4pm with self-check-in. I will send the detailed check-in instructions 3 days before your arrival.';

  it('matches exact and prefix-overlapping host drafts', () => {
    assert.equal(
      hostAlreadySentEquivalent([{ sender_type: 'host', body: welcome }], welcome),
      true
    );
    assert.equal(
      hostAlreadySentEquivalent(
        [{ sender_type: 'host', body: welcome }],
        welcome + ' Looking forward to hosting you. Jerome & Ruby'
      ),
      true
    );
    assert.equal(
      hostAlreadySentEquivalent([{ sender_type: 'guest', body: welcome }], welcome),
      false
    );
  });

  it('detects an already-sent welcome even when SQS retry reworded the draft', () => {
    const existing = [
      {
        sender_type: 'host',
        body: welcome,
      },
    ];
    const reworded =
      'Good afternoon, Julie, thank you! Check-in is at 4pm with self-check-in and we have one dedicated off-street parking spot.';
    assert.equal(looksLikeExistingWelcome(existing, reworded), true);
    assert.equal(looksLikeExistingWelcome([{ sender_type: 'guest', body: 'We agree. Thank you.' }], reworded), false);
  });
});

describe('HospitableClient._sendWithConfirm', () => {
  it('does not POST again when the timeout actually landed the draft', async () => {
    const client = new HospitableClient();
    const body = 'Good afternoon, Julie, welcome — thanks for booking with us! Check-in is at 4pm with self-check-in.';
    let posts = 0;
    const result = await client._sendWithConfirm(
      'sendMessageToReservation',
      body,
      async () => {
        posts += 1;
        throw timeoutErr(30000);
      },
      async () => [{ sender_type: 'host', body }]
    );
    assert.equal(posts, 1);
    assert.equal(result.alreadyDelivered, true);
  });
});
