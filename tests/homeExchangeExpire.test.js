import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  expireHomeExchangeBlocks,
  HomeExchangeExpireError,
  HE_EXPIRE_HARD_FAIL,
  canUnblockCalendarDay,
} from '../src/useCases/homeExchangeExpire.js';
import { STATUS_PENDING, STATUS_EXPIRED_UNBLOCKED } from '../src/useCases/homeExchangeBlocks.js';
import { isTransientHttpError } from '../src/utils/httpRetry.js';

function blockedDay(date) {
  return { date, status: { available: false, reason: 'BLOCKED', source_type: 'USER' } };
}

function openDay(date) {
  return { date, status: { available: true } };
}

function memoryStore(records) {
  const items = records.map((r) => ({ ...r }));
  return {
    items,
    async scanPending() {
      return items.filter((r) => r.status === STATUS_PENDING);
    },
    async updateStatus(exchangeId, status, extra = {}) {
      const row = items.find((r) => String(r.exchangeId) === String(exchangeId));
      if (row) Object.assign(row, { status, ...extra });
    },
  };
}

const expiredRecord = {
  exchangeId: '127232869',
  conversationId: '95101669',
  propertyId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
  homeId: '3202475',
  guestName: 'Caroline',
  checkIn: '2027-05-13',
  checkOut: '2027-05-19',
  nights: ['2027-05-13', '2027-05-14'],
  status: STATUS_PENDING,
  expiresAt: '2026-08-14T00:00:00.000Z',
};

const now = new Date('2026-08-20T00:00:00Z');

describe('expireHomeExchangeBlocks hard fail', () => {
  it('unblocks Hospitable BLOCKED nights and does not throw', async () => {
    const store = memoryStore([expiredRecord]);
    const puts = [];
    const result = await expireHomeExchangeBlocks({
      now,
      blockStore: store,
      homeExchangeClient: {
        async getConversation() {
          return { exchanges: [{ id: 127232869, status: 0, approved_at: 'x', home: { id: 3202475 } }] };
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return expiredRecord.nights.map(blockedDay);
        },
        async updatePropertyCalendar(_id, dates) {
          puts.push(dates);
          return { status: 'accepted' };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(puts[0].map((d) => d.date), expiredRecord.nights);
    assert.equal(store.items[0].status, STATUS_EXPIRED_UNBLOCKED);
  });

  it('throws HE_EXPIRE_HARD_FAIL after Hospitable PUT fails (record stays pending)', async () => {
    const store = memoryStore([expiredRecord]);
    await assert.rejects(
      () =>
        expireHomeExchangeBlocks({
          now,
          blockStore: store,
          homeExchangeClient: {
            async getConversation() {
              return { exchanges: [{ id: 127232869, status: 0, approved_at: 'x', home: { id: 3202475 } }] };
            },
          },
          hospitableClient: {
            async getPropertyCalendar() {
              return expiredRecord.nights.map(blockedDay);
            },
            async updatePropertyCalendar() {
              throw new Error('calendar write denied');
            },
          },
        }),
      (err) => {
        assert.equal(err.name, 'HomeExchangeExpireError');
        assert.match(err.message, new RegExp(HE_EXPIRE_HARD_FAIL));
        assert.match(err.message, /hospitable_unblock_failed/);
        return true;
      }
    );
    assert.equal(store.items[0].status, STATUS_PENDING);
  });

  it('treats PUT timeout as success when nights are already open on re-read', async () => {
    const store = memoryStore([expiredRecord]);
    let reads = 0;
    const result = await expireHomeExchangeBlocks({
      now,
      blockStore: store,
      homeExchangeClient: {
        async getConversation() {
          return { exchanges: [{ id: 127232869, status: 0, approved_at: 'x', home: { id: 3202475 } }] };
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          reads += 1;
          if (reads === 1) return expiredRecord.nights.map(blockedDay);
          return expiredRecord.nights.map(openDay);
        },
        async updatePropertyCalendar() {
          const err = new Error('timeout of 15000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(store.items[0].status, STATUS_EXPIRED_UNBLOCKED);
  });

  it('throws when HE conversation fetch fails (do not unblock blindly)', async () => {
    const store = memoryStore([expiredRecord]);
    await assert.rejects(
      () =>
        expireHomeExchangeBlocks({
          now,
          blockStore: store,
          homeExchangeClient: {
            async getConversation() {
              throw new Error('HE 503');
            },
          },
          hospitableClient: {
            async getPropertyCalendar() {
              throw new Error('should not read calendar');
            },
            async updatePropertyCalendar() {
              throw new Error('should not put calendar');
            },
          },
        }),
      /he_fetch_failed/
    );
    assert.equal(store.items[0].status, STATUS_PENDING);
  });

  it('throws when the block store is missing', async () => {
    await assert.rejects(
      () => expireHomeExchangeBlocks({ now, blockStore: null }),
      (err) => err instanceof HomeExchangeExpireError && /no_block_store/.test(err.message)
    );
  });

  it('throws when Hospitable calendar is empty', async () => {
    const store = memoryStore([expiredRecord]);
    await assert.rejects(
      () =>
        expireHomeExchangeBlocks({
          now,
          blockStore: store,
          homeExchangeClient: {
            async getConversation() {
              return { exchanges: [{ id: 127232869, status: 0, approved_at: 'x', home: { id: 3202475 } }] };
            },
          },
          hospitableClient: {
            async getPropertyCalendar() {
              return [];
            },
            async updatePropertyCalendar() {
              throw new Error('should not put');
            },
          },
        }),
      /calendar empty/
    );
  });
});

describe('isTransientHttpError AWS SDK', () => {
  it('retries DynamoDB throttles / 500s and not AccessDenied', () => {
    const throttle = new Error('Throughput exceeded');
    throttle.name = 'ProvisionedThroughputExceededException';
    assert.equal(isTransientHttpError(throttle), true);
    const server = new Error('ddb 500');
    server.$metadata = { httpStatusCode: 500 };
    assert.equal(isTransientHttpError(server), true);
    const denied = new Error('denied');
    denied.name = 'AccessDeniedException';
    denied.$metadata = { httpStatusCode: 400 };
    assert.equal(isTransientHttpError(denied), false);
  });
});

describe('canUnblockCalendarDay', () => {
  it('opens USER BLOCKED nights only', () => {
    assert.equal(canUnblockCalendarDay(blockedDay('2027-05-13')), true);
    assert.equal(
      canUnblockCalendarDay({
        date: '2027-05-13',
        status: { available: false, reason: 'RESERVED', source_type: 'RESERVATION' },
      }),
      false
    );
  });
});
