import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alreadySentSmokeNotice,
  buildSmokeGuestNotify,
  decideSmokeRecipients,
  extractSmokeNoticeContext,
  fillSmokeGuestTemplate,
  isRingSmokeNoticeTurn,
  LISTING_APT2,
} from '../src/useCases/ringSmokeOccupancy.js';
import { handleRingSmokeNotice } from '../src/useCases/ringSmokeNotice.js';
import { isHomeExchangePayload } from '../src/useCases/homeExchange.js';
import { LISTING_1B } from '../src/useCases/keypadLockoutOccupancy.js';

const KATIE = {
  firstName: 'Katie',
  listingId: LISTING_APT2,
  checkIn: '2026-08-16',
  checkOut: '2026-08-20',
  platform: 'homeexchange',
  conversationId: '95101669',
  propertyName: 'Pine Apt #2',
};

const JAMIE = {
  firstName: 'Jamie',
  listingId: LISTING_APT2,
  checkIn: '2026-08-16',
  checkOut: '2026-08-20',
  platform: 'hospitable',
  reservationId: 'res-apt2',
  conversationId: 'conv-apt2',
  propertyName: 'Pine Apt #2',
};

function smokeEvent({
  simulate = false,
  sendGuests = true,
  detectorName = 'Bedroom (TT7A)',
} = {}) {
  return {
    queryStringParameters: { act: 'ring_smoke_notice' },
    body: JSON.stringify({
      id: 'smoke_762914745_2026-08-18T16:50:00Z',
      action: 'ring.smoke.detected',
      data: {
        detectorName,
        detectorKey: 'bedroom',
        detectorId: '762914745',
        alarmKind: 'smoke',
        listingId: LISTING_APT2,
        propertyName: 'Pine Apt #2',
        eventAt: '2026-08-18T16:50:00Z',
        smokeKey: 'smoke_762914745_2026-08-18T16:50:00Z',
        instruction:
          'Send a message NOW to the current guests in Pine Apt #2 (Airbnb via Hospitable and/or HomeExchange).',
        simulate,
        sendGuests,
      },
    }),
  };
}

function occupancyNow() {
  return new Date('2026-08-18T16:00:00Z'); // 12:00 ET
}

describe('ring smoke occupancy routing', () => {
  it('messages every current Apt #2 guest (Airbnb and HE)', () => {
    const both = decideSmokeRecipients(
      { [LISTING_APT2]: [JAMIE, KATIE], [LISTING_1B]: [] },
      '2026-08-18',
      12
    );
    assert.equal(both.send, true);
    assert.equal(both.reason, 'unit_occupied');
    assert.equal(both.recipients.length, 2);
    assert.deepEqual(
      both.recipients.map((r) => r.platform).sort(),
      ['homeexchange', 'hospitable']
    );

    const vacant = decideSmokeRecipients({ [LISTING_APT2]: [] }, '2026-08-18', 12);
    assert.equal(vacant.send, false);
    assert.equal(vacant.reason, 'unit_vacant');
  });

  it('fills guest copy with the detector name', () => {
    const body = fillSmokeGuestTemplate('Katie', 'Bedroom (TT7A)', 'smoke');
    assert.match(body, /^Hi Katie,/);
    assert.match(body, /The Bedroom \(TT7A\) smoke detector just went off in Pine Apt #2/);
    assert.match(body, /call 911/);
    assert.match(body, /cooking or steam/);
    assert.match(body, /\nJerome\n/);
  });

  it('does not say smoke detector twice when the Ring name is generic (Carlos)', () => {
    for (const raw of ['smoke detector', 'Smoke detector', 'a smoke detector', '', null]) {
      const body = fillSmokeGuestTemplate('Carlos', raw, 'smoke');
      assert.match(
        body,
        /The smoke detector just went off in Pine Apt #2\. Please check now\./
      );
      assert.equal((body.toLowerCase().match(/smoke detector/g) || []).length, 1);
      assert.doesNotMatch(body, /detector smoke detector/i);
    }
    const hallway = fillSmokeGuestTemplate('Carlos', 'Hallway', 'smoke');
    assert.match(hallway, /The Hallway smoke detector just went off in Pine Apt #2/);
    const co = fillSmokeGuestTemplate('Carlos', 'Hallway', 'carbon monoxide');
    assert.match(co, /The Hallway carbon monoxide detector just went off in Pine Apt #2/);
  });

  it('detects the isolated act and is not HE chat', () => {
    const event = smokeEvent({ simulate: true });
    assert.equal(isRingSmokeNoticeTurn(event), true);
    assert.equal(isHomeExchangePayload(event), false);
    const ctx = extractSmokeNoticeContext(event);
    assert.equal(ctx.simulate, true);
    assert.equal(ctx.sendGuests, false);
    assert.equal(ctx.detectorName, 'Bedroom (TT7A)');
    assert.match(ctx.instruction, /Hospitable/);
  });

  it('dedupes an already-sent smoke notice for the same detector', () => {
    const body = fillSmokeGuestTemplate('Katie', 'Hallway', 'smoke');
    assert.equal(alreadySentSmokeNotice([{ body }], 'Hallway'), true);
    assert.equal(alreadySentSmokeNotice([{ body: 'Thanks!' }], 'Hallway'), false);
    assert.equal(alreadySentSmokeNotice([{ body }], 'Living Room'), false);
  });
});

describe('handleRingSmokeNotice', () => {
  it('simulation never sends and still drafts + FCM', async () => {
    const sent = [];
    const fcm = [];
    const out = await handleRingSmokeNotice({
      event: smokeEvent({ simulate: true }),
      hospitableClient: {
        getReservations: async () => [],
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
      notifyOwner: async (n) => fcm.push(n),
      now: occupancyNow(),
    });
    assert.equal(out.sent, false);
    assert.equal(out.sendSkipReason, 'simulation');
    assert.equal(out.decision.send, true);
    assert.equal(out.recipient.firstName, 'Katie');
    assert.match(out.proposedResponse, /Hi Katie,/);
    assert.match(out.proposedResponse, /Bedroom \(TT7A\)/);
    assert.deepEqual(sent, []);
    assert.equal(fcm.length, 1);
    assert.match(fcm[0].title, /sim/i);
    assert.match(fcm[0].body, /Guest send skipped/);
  });

  it('sends to both Airbnb and HE guests when both are current', async () => {
    const sent = [];
    const out = await handleRingSmokeNotice({
      event: smokeEvent({ simulate: false, sendGuests: true }),
      hospitableClient: {
        getReservations: async () => [
          {
            id: 'res-apt2',
            conversation_id: 'conv-apt2',
            check_in: '2026-08-16',
            check_out: '2026-08-20',
            platform: { name: 'airbnb' },
            guest: { first_name: 'Jamie' },
            properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
          },
        ],
        getReservationMessages: async () => [],
        sendMessageToReservation: async (id, body) => {
          sent.push({ platform: 'hospitable', id, body });
        },
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
        listMessages: async () => [],
        sendMessage: async (id, body) => {
          sent.push({ platform: 'he', id, body });
        },
      },
      notifyOwner: async () => {},
      now: occupancyNow(),
    });
    assert.equal(out.sent, true);
    assert.equal(out.sentCount, 2);
    assert.equal(sent.length, 2);
    assert.ok(sent.some((s) => s.platform === 'hospitable' && /Jamie/.test(s.body)));
    assert.ok(sent.some((s) => s.platform === 'he' && /Katie/.test(s.body)));
  });

  it('skips guest send when Apt #2 is vacant', async () => {
    const sent = [];
    const fcm = [];
    const out = await handleRingSmokeNotice({
      event: smokeEvent(),
      hospitableClient: {
        getReservations: async () => [],
        sendMessageToReservation: async () => sent.push('x'),
      },
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      notifyOwner: async (n) => fcm.push(n),
      now: occupancyNow(),
    });
    assert.equal(out.sent, false);
    assert.equal(out.decision.reason, 'unit_vacant');
    assert.deepEqual(sent, []);
    assert.match(fcm[0].title, /vacant/i);
  });

  it('owner FCM after a real send names smoke + guest', () => {
    const n = buildSmokeGuestNotify({
      simulate: false,
      decision: { reason: 'unit_occupied', send: true },
      recipients: [KATIE],
      detectorName: 'Hallway',
      alarmKind: 'smoke',
      sent: true,
      sentCount: 1,
    });
    assert.match(n.title, /message sent to Katie/);
    assert.match(n.body, /Hallway smoke detector/);
    assert.doesNotMatch(n.body, /detector smoke detector/i);
    assert.equal(n.data.listingId, LISTING_APT2);
    assert.equal(n.data.type, 'ring_smoke_guest_notice');
  });

  it('owner FCM does not double a generic smoke detector name', () => {
    const n = buildSmokeGuestNotify({
      simulate: false,
      decision: { reason: 'unit_occupied', send: true },
      recipients: [KATIE],
      detectorName: 'smoke detector',
      alarmKind: 'smoke',
      sent: true,
      sentCount: 1,
    });
    assert.match(n.body, /Apt #2 smoke detector\./);
    assert.doesNotMatch(n.body, /smoke detector smoke detector/i);
  });
});
