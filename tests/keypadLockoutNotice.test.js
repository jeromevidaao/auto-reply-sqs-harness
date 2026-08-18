import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alreadySentLockoutNotice,
  buildLockoutGuestNotify,
  decideLockoutRecipients,
  extractLockoutNoticeContext,
  fillGuestTemplate,
  isKeypadLockoutNoticeTurn,
  isStayCurrent,
  LISTING_1B,
  LISTING_APT2,
  LISTING_APT3,
  lockPhraseFor,
  normalizeHospitableGuest,
  extractHeGuestsFromConversationNodes,
} from '../src/useCases/keypadLockoutOccupancy.js';
import { handleKeypadLockoutNotice } from '../src/useCases/keypadLockoutNotice.js';
import { isHomeExchangePayload } from '../src/useCases/homeExchange.js';

const THOMAS = {
  firstName: 'Thomas',
  listingId: LISTING_1B,
  checkIn: '2026-08-17',
  checkOut: '2026-08-21',
  platform: 'hospitable',
  reservationId: 'res-1b',
  conversationId: 'conv-1b',
  propertyName: 'Pine Apt #1B',
};

const KATIE = {
  firstName: 'Katie',
  listingId: LISTING_APT2,
  checkIn: '2026-08-16',
  checkOut: '2026-08-20',
  platform: 'homeexchange',
  conversationId: '95101669',
  propertyName: 'Pine Apt #2',
};

function lockoutEvent({ simulate = false, sendGuests = true, lockName = 'backdoor' } = {}) {
  return {
    queryStringParameters: { act: 'keypad_lockout_notice' },
    body: JSON.stringify({
      id: 'lockout_backdoor_20260817T225100Z',
      action: 'keypad.lockout.notice',
      data: {
        lockName,
        lockLabel: lockName,
        listingId: LISTING_1B,
        eventAt: '2026-08-17T22:51:00Z',
        lockoutKey: 'lockout_backdoor_20260817T225100Z',
        simulate,
        sendGuests,
      },
    }),
  };
}

function occupancyNow() {
  return new Date('2026-08-17T22:00:00Z'); // 18:00 ET
}

describe('keypad lockout occupancy routing', () => {
  it('treats checkout morning as occupied only before 10am ET', () => {
    assert.equal(isStayCurrent('2026-08-15', '2026-08-17', '2026-08-17', 9), true);
    assert.equal(isStayCurrent('2026-08-15', '2026-08-17', '2026-08-17', 10), false);
    assert.equal(isStayCurrent('2026-08-17', '2026-08-21', '2026-08-17', 16), true);
  });

  it('backdoor sends only when exactly one of 1B / Apt 2 is occupied', () => {
    const only1b = decideLockoutRecipients(
      'backdoor',
      { [LISTING_1B]: [THOMAS], [LISTING_APT2]: [] },
      '2026-08-17',
      18
    );
    assert.equal(only1b.send, true);
    assert.equal(only1b.reason, 'backdoor_single_unit_occupied');
    assert.equal(only1b.recipients[0].firstName, 'Thomas');

    const both = decideLockoutRecipients(
      'backdoor',
      { [LISTING_1B]: [THOMAS], [LISTING_APT2]: [KATIE] },
      '2026-08-17',
      18
    );
    assert.equal(both.send, false);
    assert.equal(both.reason, 'backdoor_both_occupied');
    assert.deepEqual(both.recipients, []);

    const none = decideLockoutRecipients('backdoor', {}, '2026-08-17', 18);
    assert.equal(none.send, false);
    assert.equal(none.reason, 'backdoor_neither_occupied');
  });

  it('unit locks message that unit; basement never messages', () => {
    const unit = decideLockoutRecipients('1b', { [LISTING_1B]: [THOMAS] }, '2026-08-17', 18);
    assert.equal(unit.send, true);
    const apt2 = decideLockoutRecipients(
      'apt2back',
      { [LISTING_APT2]: [KATIE] },
      '2026-08-17',
      18
    );
    assert.equal(apt2.send, true);
    const vacant = decideLockoutRecipients('apt3', {}, '2026-08-17', 18);
    assert.equal(vacant.send, false);
    const basement = decideLockoutRecipients(
      'basement',
      { [LISTING_1B]: [THOMAS] },
      '2026-08-17',
      18
    );
    assert.equal(basement.send, false);
    assert.equal(basement.reason, 'lock_not_messageable');
  });
});

describe('keypad lockout template + payload', () => {
  it('fills the approved guest copy', () => {
    const body = fillGuestTemplate('Thomas', 'backdoor');
    assert.match(body, /^Hi Thomas,/);
    assert.match(body, /shared building entrance keypad \(parking side\)/);
    assert.match(body, /1 to 5 minutes/);
    assert.match(body, /last 4 digits of the phone number/);
    assert.match(body, /do not try extra codes/);
    assert.match(body, /Warm regards,\nJerome/);
    assert.equal(/backup/i.test(body), false);
    assert.equal(lockPhraseFor('1b'), 'the Apt 1B door keypad');
    assert.equal(lockPhraseFor('apt3'), 'the Apt 3 apartment door keypad');
  });

  it('detects the isolated act and does not look like HomeExchange chat', () => {
    const event = lockoutEvent({ simulate: true });
    assert.equal(isKeypadLockoutNoticeTurn(event), true);
    assert.equal(isHomeExchangePayload(event), false);
    const ctx = extractLockoutNoticeContext(event);
    assert.equal(ctx.simulate, true);
    assert.equal(ctx.sendGuests, false);
    assert.equal(ctx.lockName, 'backdoor');
  });

  it('dedupes an already-sent lockout notice for the same lock phrase', () => {
    const phrase = lockPhraseFor('backdoor');
    const body = fillGuestTemplate('Thomas', 'backdoor');
    assert.equal(alreadySentLockoutNotice([{ body }], phrase), true);
    assert.equal(alreadySentLockoutNotice([{ body: 'Thanks!' }], phrase), false);
    assert.equal(
      alreadySentLockoutNotice([{ body: fillGuestTemplate('X', '1b') }], phrase),
      false
    );
  });
});

describe('normalize occupancy sources', () => {
  it('keeps Airbnb reservations and drops HE-platform Hospitable rows', () => {
    const airbnb = normalizeHospitableGuest({
      id: 'res-1',
      conversation_id: 'c1',
      check_in: '2026-08-17',
      check_out: '2026-08-21',
      platform: { name: 'airbnb' },
      guest: { first_name: 'Thomas' },
      properties: [{ id: 'c899481f-2e5b-402d-80c4-3167fd824d96' }],
    });
    assert.equal(airbnb.firstName, 'Thomas');
    assert.equal(airbnb.listingId, LISTING_1B);
    assert.equal(airbnb.platform, 'hospitable');

    const heOnHospitable = normalizeHospitableGuest({
      id: 'res-he',
      check_in: '2026-08-17',
      check_out: '2026-08-20',
      platform: { name: 'HomeExchange' },
      guest: { first_name: 'Katie' },
      properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
    });
    assert.equal(heOnHospitable, null);

    const cancelled = normalizeHospitableGuest({
      id: 'res-x',
      status: 'cancelled',
      check_in: '2026-08-17',
      check_out: '2026-08-21',
      guest: { first_name: 'Nope' },
      properties: [{ id: 'c899481f-2e5b-402d-80c4-3167fd824d96' }],
    });
    assert.equal(cancelled, null);
  });

  it('extracts finalized Pine HE stays only', () => {
    const guests = extractHeGuestsFromConversationNodes([
      {
        id: 99,
        interlocutor: { first_name: 'Katie' },
        exchanges: [
          {
            id: 1,
            status: 3,
            finalized_at: '2026-08-15',
            start_on: '2026-08-16',
            end_on: '2026-08-20',
            home: { id: 3285044 },
            guest: { first_name: 'Katie' },
          },
        ],
      },
      {
        id: 100,
        exchanges: [
          {
            status: 1,
            start_on: '2026-08-17',
            end_on: '2026-08-19',
            home: { id: 3285159 },
            guest: { first_name: 'NotFinal' },
          },
        ],
      },
    ]);
    assert.equal(guests.length, 1);
    assert.equal(guests[0].listingId, LISTING_APT2);
    assert.equal(guests[0].platform, 'homeexchange');
    assert.equal(guests[0].firstName, 'Katie');
  });
});

describe('handleKeypadLockoutNotice', () => {
  it('simulation never sends to the guest and still reports the draft', async () => {
    const sent = [];
    const fcm = [];
    const hospitableClient = {
      getReservations: async () => [
        {
          id: 'res-1b',
          conversation_id: 'conv-1b',
          check_in: '2026-08-17',
          check_out: '2026-08-21',
          platform: { name: 'airbnb' },
          guest: { first_name: 'Thomas' },
          properties: [{ id: 'c899481f-2e5b-402d-80c4-3167fd824d96' }],
        },
      ],
      sendMessageToReservation: async () => {
        sent.push('hospitable');
      },
    };
    const homeExchangeClient = {
      listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      sendMessage: async () => {
        sent.push('he');
      },
    };
    const out = await handleKeypadLockoutNotice({
      event: lockoutEvent({ simulate: true }),
      hospitableClient,
      homeExchangeClient,
      notifyOwner: async (n) => fcm.push(n),
      now: occupancyNow(),
    });
    assert.equal(out.sent, false);
    assert.equal(out.sendSkipReason, 'simulation');
    assert.equal(out.decision.send, true);
    assert.equal(out.recipient.firstName, 'Thomas');
    assert.match(out.proposedResponse, /Hi Thomas,/);
    assert.match(out.proposedResponse, /shared building entrance/);
    assert.deepEqual(sent, []);
    assert.equal(fcm.length, 1);
    assert.match(fcm[0].title, /sim/i);
    assert.match(fcm[0].body, /Guest send skipped/);
  });

  it('does not message guests when both 1B and Apt 2 are occupied', async () => {
    const sent = [];
    const out = await handleKeypadLockoutNotice({
      event: lockoutEvent({ simulate: false, sendGuests: true }),
      hospitableClient: {
        getReservations: async () => [
          {
            id: 'res-1b',
            conversation_id: 'conv-1b',
            check_in: '2026-08-17',
            check_out: '2026-08-21',
            platform: { name: 'airbnb' },
            guest: { first_name: 'Thomas' },
            properties: [{ id: 'c899481f-2e5b-402d-80c4-3167fd824d96' }],
          },
        ],
        sendMessageToReservation: async () => sent.push('hospitable'),
      },
      homeExchangeClient: {
        listConversations: async () => ({
          data: {
            conversations: {
              edges: [
                {
                  node: {
                    id: 95101669,
                    interlocutor: { first_name: 'Katie' },
                    exchanges: [
                      {
                        status: 3,
                        finalized_at: '2026-08-10',
                        start_on: '2026-08-16',
                        end_on: '2026-08-20',
                        home: { id: 3285044 },
                        guest: { first_name: 'Katie' },
                      },
                    ],
                  },
                },
              ],
            },
          },
        }),
        sendMessage: async () => sent.push('he'),
      },
      notifyOwner: async () => {},
      now: occupancyNow(),
    });
    assert.equal(out.sent, false);
    assert.equal(out.decision.reason, 'backdoor_both_occupied');
    assert.deepEqual(sent, []);
  });

  it('sends the template to the current Airbnb guest on a unit lock', async () => {
    const sent = [];
    const hospitableClient = {
      getReservations: async () => [
        {
          id: 'res-1b',
          conversation_id: 'conv-1b',
          check_in: '2026-08-17',
          check_out: '2026-08-21',
          platform: { name: 'airbnb' },
          guest: { first_name: 'Thomas' },
          properties: [{ id: 'c899481f-2e5b-402d-80c4-3167fd824d96' }],
        },
      ],
      getReservationMessages: async () => [],
      sendMessageToReservation: async (id, body) => {
        sent.push({ id, body });
      },
    };
    const out = await handleKeypadLockoutNotice({
      event: lockoutEvent({ lockName: '1b', simulate: false, sendGuests: true }),
      hospitableClient,
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      notifyOwner: async () => {},
      now: occupancyNow(),
    });
    assert.equal(out.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'res-1b');
    assert.match(sent[0].body, /Apt 1B door keypad/);
    assert.match(sent[0].body, /Hi Thomas,/);
  });

  it('retries occupancy lookup failures without sending', async () => {
    const out = await handleKeypadLockoutNotice({
      event: lockoutEvent({ lockName: '1b' }),
      hospitableClient: {
        getReservations: async () => {
          throw new Error('hospitable 503');
        },
      },
      homeExchangeClient: { listConversations: async () => ({}) },
      notifyOwner: async () => {},
      now: occupancyNow(),
    });
    assert.equal(out.sent, false);
    assert.equal(out.sendSkipReason, 'occupancy_lookup_failed');
    assert.match(out.occupancyError, /503/);
  });

  it('owner FCM for both-occupied names Android-only', () => {
    const n = buildLockoutGuestNotify({
      simulate: false,
      decision: { reason: 'backdoor_both_occupied', send: false },
      lockName: 'backdoor',
    });
    assert.match(n.title, /no guest message/);
    assert.match(n.body, /both occupied/);
  });

  it('does not treat apt3 listing id as unused', () => {
    assert.equal(LISTING_APT3, '24259977');
  });
});
