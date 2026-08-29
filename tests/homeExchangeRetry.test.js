import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HomeExchangeClient, alreadySentEquivalent } from '../src/clients/HomeExchangeClient.js';
import { anyExchangeApproved, isApprovedExchange } from '../src/clients/homeExchangeExchange.js';
import {
  HE_MAX_ATTEMPTS,
  HE_TIMEOUT_MS,
  WRITE_BACKOFF_MS,
  WRITE_MAX_ATTEMPTS,
  computeRetryDelay,
  isTransientHttpError,
  withExponentialBackoff,
} from '../src/utils/httpRetry.js';

function timeoutErr(ms = HE_TIMEOUT_MS) {
  const err = new Error(`timeout of ${ms}ms exceeded`);
  err.code = 'ECONNABORTED';
  return err;
}

function statusErr(status, message = `Request failed with status code ${status}`) {
  const err = new Error(message);
  err.response = { status };
  return err;
}

function openExchange(overrides = {}) {
  return {
    id: 127232869,
    status: 0,
    approved_at: null,
    finalized_at: null,
    home: { id: 3202475 },
    ...overrides,
  };
}

describe('HE / write retry profile (4 attempts over ~1 min)', () => {
  it('uses 4 attempts and 5/15/30s write backoff', () => {
    assert.equal(HE_MAX_ATTEMPTS, 4);
    assert.equal(WRITE_MAX_ATTEMPTS, 4);
    assert.deepEqual(WRITE_BACKOFF_MS, [5000, 15000, 30000]);
    const waits = [1, 2, 3].map((attempt) =>
      computeRetryDelay(timeoutErr(), { attempt, kind: 'write', jitter: false })
    );
    assert.deepEqual(waits, [5000, 15000, 30000]);
    const waitTotal = waits.reduce((a, b) => a + b, 0);
    assert.ok(waitTotal <= 60_000, `sleeps ${waitTotal}ms`);
    assert.ok(waitTotal >= 45_000, `sleeps ${waitTotal}ms`);
  });

  it('does not retry permanent 4xx or marked-permanent errors', () => {
    assert.equal(isTransientHttpError(statusErr(400)), false);
    const marked = new Error('no exchanges on conversation');
    marked.permanent = true;
    assert.equal(isTransientHttpError(marked), false);
  });

  it('retries HE write transients then succeeds', async () => {
    const delays = [];
    let n = 0;
    const out = await withExponentialBackoff(
      async () => {
        n += 1;
        if (n < 3) throw timeoutErr();
        return { ok: true, n };
      },
      {
        operation: 'heApproveConversation',
        kind: 'write',
        jitter: false,
        sleeper: async (ms) => {
          delays.push(ms);
        },
      }
    );
    assert.deepEqual(out, { ok: true, n: 3 });
    assert.deepEqual(delays, [5000, 15000]);
  });
});

describe('HomeExchangeClient retries', () => {
  it('retries getConversation on timeout then returns the thread', async () => {
    let gets = 0;
    const client = new HomeExchangeClient({
      token: 'test',
      sleeper: async () => {},
      http: {
        get: async () => {
          gets += 1;
          if (gets < 3) throw timeoutErr();
          return { data: { data: { conversation: { id: 95101669, accepted: 0 } } } };
        },
      },
    });
    const conv = await client.getConversation('95101669');
    assert.equal(conv.id, 95101669);
    assert.equal(gets, 3);
  });

  it('does not retry a 400 approve (wrong exchange-id path)', async () => {
    let patches = 0;
    const client = new HomeExchangeClient({
      token: 'test',
      sleeper: async () => {
        throw new Error('should not sleep on 400');
      },
      http: {
        get: async () => ({ data: [openExchange()] }),
        patch: async () => {
          patches += 1;
          throw statusErr(400, 'Undefined offset: 0');
        },
      },
    });
    await assert.rejects(() => client.approveConversation('95101669'), /failed after 1 attempt/);
    assert.equal(patches, 1);
  });

  it('does not convert a reciprocal stay; skips decline', async () => {
    const patches = [];
    const client = new HomeExchangeClient({
      token: 'test',
      http: {
        get: async (url) => {
          if (String(url).includes('/exchange/v2/')) {
            throw new Error('v2 should not be called for reciprocal skip');
          }
          return {
            data: {
              conversation: {
                id: 95598827,
                accepted: null,
                exchanges: [
                  { id: 127810197, type: 2, home: { id: 3285044 } },
                  { id: 127810198, type: 2, home: { id: 3298786 } },
                ],
              },
            },
          };
        },
        patch: async (url, body) => {
          patches.push({ url, body });
          return { data: { ok: true } };
        },
      },
    });
    const out = await client.declineConversation('95598827');
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'reciprocal_cannot_decline');
    assert.equal(out.declined, undefined);
    assert.deepEqual(patches, []);
  });

  it('PATCHes bff manual-decline for a pending GuestPoints request', async () => {
    const patches = [];
    let stayStatus = 'NEW';
    const client = new HomeExchangeClient({
      token: 'test',
      http: {
        get: async (url) => {
          if (String(url).includes('/exchange/v2/')) {
            return {
              data: { stayRequest: { stayRequestStatus: stayStatus, stayType: 'WITH-GP' } },
            };
          }
          return {
            data: {
              conversation: {
                id: 95201321,
                accepted: null,
                exchanges: [{ id: 1, type: 1, status: 0, home: { id: 3285044 } }],
              },
            },
          };
        },
        patch: async (url, body) => {
          patches.push({ url, body });
          stayStatus = 'MANUALLY_DECLINED';
          return { data: { ok: true } };
        },
      },
    });
    const out = await client.declineConversation('95201321');
    assert.equal(out.declined, true);
    assert.equal(patches.some((p) => /change-to-non-reciprocal/.test(p.url)), false);
    const decline = patches.find((p) => /\/manual-decline$/.test(p.url));
    assert.ok(decline);
    assert.deepEqual(decline.body, { isPresetModified: true });
  });

  it('PATCHes /v1/exchanges/{conversationId}/approve with the get-exchanges array', async () => {
    const exchanges = [openExchange()];
    let patchUrl = null;
    let patchBody = null;
    const client = new HomeExchangeClient({
      token: 'test',
      http: {
        get: async () => ({ data: exchanges }),
        patch: async (url, body) => {
          patchUrl = url;
          patchBody = body;
          return { data: { ok: true } };
        },
      },
    });
    await client.approveConversation('95101669');
    assert.match(patchUrl, /\/v1\/exchanges\/95101669\/approve$/);
    assert.deepEqual(patchBody, exchanges);
  });

  it('treats approve timeout as success when get-exchanges shows approved_at', async () => {
    let patches = 0;
    let gets = 0;
    const client = new HomeExchangeClient({
      token: 'test',
      sleeper: async () => {
        throw new Error('should not sleep when recover succeeds');
      },
      http: {
        get: async () => {
          gets += 1;
          if (gets === 1) return { data: [openExchange()] };
          return { data: [openExchange({ status: 1, approved_at: '2026-08-15T17:34:40Z' })] };
        },
        patch: async () => {
          patches += 1;
          throw timeoutErr();
        },
      },
    });
    const out = await client.approveConversation('95101669');
    assert.equal(patches, 1);
    assert.equal(out.alreadyApproved, true);
    assert.equal(out.recovered, true);
  });

  it('does not POST again when send timeout already landed the draft', async () => {
    const body =
      'Hi Caroline, I just sent you a pre-approval on HomeExchange and blocked those dates for you.';
    let posts = 0;
    const client = new HomeExchangeClient({
      token: 'test',
      sleeper: async () => {
        throw new Error('should not sleep when recover succeeds');
      },
      http: {
        get: async () => ({ data: { data: { messages: [{ content: body }] } } }),
        post: async () => {
          posts += 1;
          throw timeoutErr();
        },
      },
    });
    const out = await client.sendMessage('95101669', body);
    assert.equal(posts, 1);
    assert.equal(out.alreadyDelivered, true);
    assert.equal(alreadySentEquivalent([{ content: body }], body), true);
  });
});

describe('isApprovedExchange', () => {
  it('treats approved_at, status 1, and finalized as approved', () => {
    assert.equal(isApprovedExchange(openExchange()), false);
    assert.equal(isApprovedExchange(openExchange({ approved_at: 'x' })), true);
    assert.equal(isApprovedExchange(openExchange({ status: 1 })), true);
    assert.equal(anyExchangeApproved([openExchange(), openExchange({ status: 1 })]), true);
  });
});
