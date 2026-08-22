import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lockKeyFor,
  acquireReservationLock,
  releaseReservationLock,
} from '../src/utils/reservationLock.js';

function failedCondition() {
  const e = new Error('The conditional request failed');
  e.name = 'ConditionalCheckFailedException';
  return e;
}

function fakeDdb() {
  const items = new Map();
  return {
    items,
    async send(cmd) {
      const input = cmd.input;
      const item = input.Item;
      const key = item.webhookId;
      const cond = input.ConditionExpression || '';
      const vals = input.ExpressionAttributeValues || {};
      if (cond.includes('attribute_not_exists')) {
        const existing = items.get(key);
        if (
          !existing ||
          existing.expiresAt < vals[':now'] ||
          existing.released === vals[':t']
        ) {
          items.set(key, { ...item });
          return {};
        }
        throw failedCondition();
      }
      if (cond.includes('holder = :me')) {
        const existing = items.get(key);
        if (!existing || existing.holder !== vals[':me']) throw failedCondition();
        items.set(key, { ...item });
        return {};
      }
      items.set(key, { ...item });
      return {};
    },
  };
}

describe('reservationLock', () => {
  it('prefers reservationId over conversationId', () => {
    assert.equal(lockKeyFor({ reservationId: 'r1', conversationId: 'c1' }), 'lock:resv:r1');
    assert.equal(lockKeyFor({ conversationId: 'c1' }), 'lock:conv:c1');
    assert.equal(lockKeyFor({}), null);
  });

  it('skips when ddb or id is missing', async () => {
    const noDdb = await acquireReservationLock({ reservationId: 'r1', holder: 'h' });
    assert.equal(noDdb.skipped, true);
    assert.equal(noDdb.reason, 'no_ddb');
    const noId = await acquireReservationLock({ ddb: fakeDdb(), holder: 'h' });
    assert.equal(noId.skipped, true);
    assert.equal(noId.reason, 'no_id');
  });

  it('acquires immediately on an empty key', async () => {
    const ddb = fakeDdb();
    const got = await acquireReservationLock({
      ddb,
      reservationId: '680feb40-0b25-49a6-a68d-45d5c6a52f18',
      holder: 'req-1',
    });
    assert.equal(got.acquired, true);
    assert.equal(got.key, 'lock:resv:680feb40-0b25-49a6-a68d-45d5c6a52f18');
    assert.equal(got.waitedMs, 0);
    assert.equal(ddb.items.get(got.key).holder, 'req-1');
  });

  it('second holder waits until the first releases (Michael stampede)', async () => {
    const ddb = fakeDdb();
    const first = await acquireReservationLock({
      ddb,
      reservationId: 'r-michael',
      holder: 'dc1fd54d',
      pollMs: 5,
    });
    assert.equal(first.acquired, true);

    let released = false;
    const second = await acquireReservationLock({
      ddb,
      reservationId: 'r-michael',
      holder: '93e4d630',
      waitMs: 200,
      pollMs: 5,
      sleeper: async () => {
        if (!released) {
          const rel = await releaseReservationLock({
            ddb,
            key: first.key,
            holder: 'dc1fd54d',
          });
          assert.equal(rel.released, true);
          released = true;
        }
      },
    });
    assert.equal(second.acquired, true);
    assert.ok(second.waitedMs >= 5, `waited ${second.waitedMs}`);
    assert.equal(ddb.items.get(first.key).holder, '93e4d630');
  });

  it('times out and proceeds without the lock', async () => {
    const ddb = fakeDdb();
    await acquireReservationLock({ ddb, reservationId: 'r1', holder: 'h1' });
    const second = await acquireReservationLock({
      ddb,
      reservationId: 'r1',
      holder: 'h2',
      waitMs: 20,
      pollMs: 8,
      sleeper: async () => {},
    });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'timeout');
    assert.equal(ddb.items.get(second.key).holder, 'h1');
  });

  it('steals an expired lock', async () => {
    const ddb = fakeDdb();
    let t = 1_000_000;
    const first = await acquireReservationLock({
      ddb,
      reservationId: 'r1',
      holder: 'old',
      ttlSec: 10,
      clock: () => t,
      now: t,
    });
    assert.equal(first.acquired, true);
    t += 11_000;
    const second = await acquireReservationLock({
      ddb,
      reservationId: 'r1',
      holder: 'new',
      clock: () => t,
      now: t,
    });
    assert.equal(second.acquired, true);
    assert.equal(second.waitedMs, 0);
    assert.equal(ddb.items.get(first.key).holder, 'new');
  });

  it('does not release a lock held by someone else', async () => {
    const ddb = fakeDdb();
    const got = await acquireReservationLock({ ddb, reservationId: 'r1', holder: 'h1' });
    const rel = await releaseReservationLock({ ddb, key: got.key, holder: 'h2' });
    assert.equal(rel.released, false);
    assert.equal(rel.reason, 'not_holder');
    assert.equal(ddb.items.get(got.key).holder, 'h1');
    assert.equal(ddb.items.get(got.key).released, false);
  });
});
