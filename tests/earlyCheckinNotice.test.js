import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alreadySentUnitReadyNotice,
  buildEarlyCheckinGuestNotify,
  decideUnitReadyRecipients,
  extractEarlyCheckinNoticeContext,
  fillUnitReadyTemplate,
  hasCheckoutToday,
  isEarlyCheckinNoticeTurn,
  isNoonVacantSource,
  isWithinUnitReadySendWindow,
  LISTING_1B,
  LISTING_APT2,
  nyClock,
  pickNextCheckinGuests,
  unitReadySkipReason,
} from '../src/useCases/earlyCheckinOccupancy.js';
import { handleEarlyCheckinNotice } from '../src/useCases/earlyCheckinNotice.js';
import { isHomeExchangePayload } from '../src/useCases/homeExchange.js';

const JAMIE = {
  firstName: 'Jamie',
  listingId: LISTING_APT2,
  checkIn: '2026-08-26',
  checkOut: '2026-08-28',
  platform: 'hospitable',
  reservationId: 'res-apt2',
  conversationId: 'conv-apt2',
  guestName: 'Jamie Guest',
  propertyName: 'Pine Apt #2',
};

const KATIE = {
  firstName: 'Katie',
  listingId: LISTING_APT2,
  checkIn: '2026-08-26',
  checkOut: '2026-08-30',
  platform: 'homeexchange',
  conversationId: '95101669',
  guestName: 'Katie',
  propertyName: 'Pine Apt #2',
};

const THOMAS = {
  firstName: 'Thomas',
  listingId: LISTING_1B,
  checkIn: '2026-08-26',
  checkOut: '2026-08-28',
  platform: 'hospitable',
  reservationId: 'res-1b',
  conversationId: 'conv-1b',
  propertyName: 'Pine Apt #1B',
};

function readyEvent({
  simulate = false,
  sendGuests = true,
  listingId = LISTING_APT2,
  date = '2026-08-26',
  source = 'cleaning',
  action = 'cleaning.unit_ready',
} = {}) {
  const noon = source === 'noon_vacant' || action === 'noon.vacant_unit_ready';
  return {
    queryStringParameters: { act: 'early_checkin_notice' },
    body: JSON.stringify({
      id: noon
        ? `early_checkin_noon_${listingId}_${date}`
        : `early_checkin_${listingId}_${date}`,
      action: noon ? 'noon.vacant_unit_ready' : action,
      data: {
        listingId,
        listingName: listingId === LISTING_1B ? 'Pine Apt #1B' : 'Pine Apt #2',
        date,
        source: noon ? 'noon_vacant' : source,
        eventAt: '2026-08-26T19:00:00Z',
        instruction:
          'Send the unit-ready early check-in message to the guest checking in today on this listing (Airbnb via Hospitable or HomeExchange, whichever is next).',
        simulate,
        sendGuests,
      },
    }),
  };
}

function noonEvent(extra = {}) {
  return readyEvent({ ...extra, source: 'noon_vacant', action: 'noon.vacant_unit_ready' });
}

function uncleanedDdb(item) {
  return {
    send: async (cmd) => {
      if (cmd.input?.TableName === 'uncleanedUnits') {
        return item ? { Item: item } : {};
      }
      return {};
    },
  };
}

function atEt(hour, minute = 0) {
  // 2026-08-26 is EDT (UTC-4).
  const utcHour = hour + 4;
  return new Date(
    `2026-08-26T${String(utcHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`
  );
}

function airbnbClient(guest, extra = {}) {
  return {
    getReservations: async () => [
      {
        id: guest.reservationId,
        conversation_id: guest.conversationId,
        check_in: guest.checkIn,
        check_out: guest.checkOut,
        platform: { name: 'airbnb' },
        guest: { first_name: guest.firstName, last_name: 'Guest' },
        properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
      },
    ],
    getReservationMessages: async () => extra.messages || [],
    sendMessageToReservation: extra.sendMessageToReservation,
  };
}

function heClient(guest, extra = {}) {
  return {
    listConversations: async () => ({
      data: {
        conversations: {
          edges: [
            {
              node: {
                id: Number(guest.conversationId),
                interlocutor: { first_name: guest.firstName },
                exchanges: [
                  {
                    status: 3,
                    finalized_at: '2026-08-20',
                    start_on: guest.checkIn,
                    end_on: guest.checkOut,
                    home: { id: 3285044 },
                    guest: { first_name: guest.firstName },
                  },
                ],
              },
            },
          ],
        },
      },
    }),
    listMessages: async () => extra.messages || [],
    sendMessage: extra.sendMessage,
  };
}

describe('early check-in send window (8am–4pm ET, not after 4pm)', () => {
  it('sends at 8:00, 3:30, and 3:59 ET; skips 7:59, 4:00, and 4:01', () => {
    assert.equal(isWithinUnitReadySendWindow(atEt(8, 0)), true);
    assert.equal(isWithinUnitReadySendWindow(atEt(15, 30)), true);
    assert.equal(isWithinUnitReadySendWindow(atEt(15, 59)), true);
    assert.equal(isWithinUnitReadySendWindow(atEt(7, 59)), false);
    assert.equal(isWithinUnitReadySendWindow(atEt(16, 0)), false);
    assert.equal(isWithinUnitReadySendWindow(atEt(16, 1)), false);
    assert.equal(unitReadySkipReason(atEt(16, 0)), 'after_4pm_et');
    assert.equal(unitReadySkipReason(atEt(7, 59)), 'before_8am_et');
    assert.equal(unitReadySkipReason(atEt(15, 59)), null);
    assert.equal(nyClock(atEt(15, 59)).hourNy, 15);
    assert.equal(nyClock(atEt(15, 59)).minuteNy, 59);
  });
});

describe('early check-in occupancy routing', () => {
  it('messages the Airbnb guest checking in today', () => {
    const out = decideUnitReadyRecipients(
      LISTING_APT2,
      { [LISTING_APT2]: [JAMIE] },
      '2026-08-26',
      atEt(15, 45)
    );
    assert.equal(out.send, true);
    assert.equal(out.reason, 'next_checkin_airbnb');
    assert.equal(out.recipients.length, 1);
    assert.equal(out.recipients[0].firstName, 'Jamie');
    assert.equal(out.recipients[0].platform, 'hospitable');
  });

  it('messages the HE guest checking in today when there is no Airbnb arrival', () => {
    const out = decideUnitReadyRecipients(
      LISTING_APT2,
      { [LISTING_APT2]: [KATIE] },
      '2026-08-26',
      atEt(12, 0)
    );
    assert.equal(out.send, true);
    assert.equal(out.reason, 'next_checkin_he');
    assert.equal(out.recipients[0].firstName, 'Katie');
    assert.equal(out.recipients[0].platform, 'homeexchange');
  });

  it('messages both when Airbnb and HE both check in today on the same listing', () => {
    const out = decideUnitReadyRecipients(
      LISTING_APT2,
      { [LISTING_APT2]: [JAMIE, KATIE] },
      '2026-08-26',
      atEt(11, 0)
    );
    assert.equal(out.send, true);
    assert.equal(out.reason, 'next_checkin_airbnb_and_he');
    assert.deepEqual(
      out.recipients.map((r) => r.platform).sort(),
      ['homeexchange', 'hospitable']
    );
  });

  it('does not message a mid-stay guest who checked in yesterday', () => {
    const midStay = { ...JAMIE, checkIn: '2026-08-24', checkOut: '2026-08-28' };
    const out = decideUnitReadyRecipients(
      LISTING_APT2,
      { [LISTING_APT2]: [midStay] },
      '2026-08-26',
      atEt(11, 0)
    );
    assert.equal(out.send, false);
    assert.equal(out.reason, 'no_checkin_today');
  });

  it('skips after 4pm ET even when a guest is checking in today', () => {
    const out = decideUnitReadyRecipients(
      LISTING_APT2,
      { [LISTING_APT2]: [JAMIE] },
      '2026-08-26',
      atEt(16, 0)
    );
    assert.equal(out.send, false);
    assert.equal(out.reason, 'after_4pm_et');
    assert.deepEqual(out.recipients, []);
  });

  it('noon vacant skips when someone is checking out today, even with an arrival', () => {
    const departing = { ...JAMIE, checkIn: '2026-08-24', checkOut: '2026-08-26' };
    const out = decideUnitReadyRecipients(
      LISTING_APT2,
      { [LISTING_APT2]: [departing, KATIE] },
      '2026-08-26',
      atEt(12, 0),
      { requireVacantOvernight: true }
    );
    assert.equal(out.send, false);
    assert.equal(out.reason, 'checkout_today');
    assert.equal(out.recipients[0].firstName, 'Katie');
    assert.equal(hasCheckoutToday([departing, KATIE], '2026-08-26'), true);
  });

  it('post-cleaning still messages the arrival when there is a same-day checkout', () => {
    const departing = { ...JAMIE, checkIn: '2026-08-24', checkOut: '2026-08-26' };
    const out = decideUnitReadyRecipients(
      LISTING_APT2,
      { [LISTING_APT2]: [departing, KATIE] },
      '2026-08-26',
      atEt(12, 0)
    );
    assert.equal(out.send, true);
    assert.equal(out.reason, 'next_checkin_he');
    assert.equal(out.recipients[0].firstName, 'Katie');
  });

  it('noon vacant skips when the listing is still in uncleanedUnits', () => {
    const out = decideUnitReadyRecipients(
      LISTING_APT2,
      { [LISTING_APT2]: [JAMIE] },
      '2026-08-26',
      atEt(12, 0),
      { requireVacantOvernight: true, uncleaned: true }
    );
    assert.equal(out.send, false);
    assert.equal(out.reason, 'uncleaned_unit');
  });

  it('does not send a 1B cleaning notice to an Apt #2 arrival', () => {
    const out = decideUnitReadyRecipients(
      LISTING_1B,
      { [LISTING_APT2]: [JAMIE], [LISTING_1B]: [] },
      '2026-08-26',
      atEt(11, 0)
    );
    assert.equal(out.send, false);
    assert.equal(out.reason, 'no_checkin_today');
  });

  it('ignores other-listing guests when picking next check-in', () => {
    const arriving = pickNextCheckinGuests([THOMAS, JAMIE], '2026-08-26');
    assert.equal(arriving.length, 2);
    const onlyApt2 = pickNextCheckinGuests([JAMIE], '2026-08-25');
    assert.equal(onlyApt2.length, 0);
  });
});

describe('early check-in template + payload', () => {
  it('keeps the existing unit-ready copy (anti-contradiction phrase)', () => {
    const body = fillUnitReadyTemplate('Jamie');
    assert.equal(
      body,
      'Hi Jamie,\nWe are pleased to let you know that the unit is ready for you to check in now.'
    );
  });

  it('detects the isolated act and is not HE chat', () => {
    const event = readyEvent({ simulate: true });
    assert.equal(isEarlyCheckinNoticeTurn(event), true);
    assert.equal(isHomeExchangePayload(event), false);
    const ctx = extractEarlyCheckinNoticeContext(event);
    assert.equal(ctx.simulate, true);
    assert.equal(ctx.sendGuests, false);
    assert.equal(ctx.listingId, LISTING_APT2);
    assert.equal(ctx.source, 'cleaning');
    assert.equal(ctx.requireVacantOvernight, false);
  });

  it('detects the noon vacant-overnight source', () => {
    const event = noonEvent();
    assert.equal(isEarlyCheckinNoticeTurn(event), true);
    assert.equal(isHomeExchangePayload(event), false);
    assert.equal(isNoonVacantSource('noon.vacant_unit_ready'), true);
    const ctx = extractEarlyCheckinNoticeContext(event);
    assert.equal(ctx.source, 'noon_vacant');
    assert.equal(ctx.requireVacantOvernight, true);
    assert.equal(ctx.sendGuests, true);
    assert.equal(ctx.listingId, LISTING_APT2);
  });

  it('dedupes an already-sent unit-ready notice', () => {
    const body = fillUnitReadyTemplate('Jamie');
    assert.equal(alreadySentUnitReadyNotice([{ body }]), true);
    assert.equal(alreadySentUnitReadyNotice([{ body: 'Thanks!' }]), false);
  });
});

describe('handleEarlyCheckinNotice', () => {
  it('sends at 3:45 PM ET to the Airbnb guest checking in today', async () => {
    const sent = [];
    const out = await handleEarlyCheckinNotice({
      event: readyEvent(),
      hospitableClient: airbnbClient(JAMIE, {
        sendMessageToReservation: async (id, body) => sent.push({ platform: 'hospitable', id, body }),
      }),
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      notifyOwner: async () => {},
      now: atEt(15, 45),
    });
    assert.equal(out.sent, true);
    assert.equal(out.sentCount, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'res-apt2');
    assert.match(sent[0].body, /Hi Jamie,/);
    assert.match(sent[0].body, /unit is ready for you to check in now/);
    assert.equal(out.decision.reason, 'next_checkin_airbnb');
  });

  it('sends to the HE guest when they are the next check-in', async () => {
    const sent = [];
    const out = await handleEarlyCheckinNotice({
      event: readyEvent(),
      hospitableClient: {
        getReservations: async () => [],
        sendMessageToReservation: async () => sent.push('hospitable'),
      },
      homeExchangeClient: heClient(KATIE, {
        sendMessage: async (id, body) => sent.push({ platform: 'he', id, body }),
      }),
      notifyOwner: async () => {},
      now: atEt(12, 0),
    });
    assert.equal(out.sent, true);
    assert.equal(out.recipient.platform, 'homeexchange');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].platform, 'he');
    assert.match(sent[0].body, /Hi Katie,/);
  });

  it('does not send at or after 4:00 PM ET', async () => {
    const sent = [];
    const fcm = [];
    const out = await handleEarlyCheckinNotice({
      event: readyEvent(),
      hospitableClient: airbnbClient(JAMIE, {
        sendMessageToReservation: async () => sent.push('hospitable'),
      }),
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      notifyOwner: async (n) => fcm.push(n),
      now: atEt(16, 0),
    });
    assert.equal(out.sent, false);
    assert.equal(out.sendSkipReason, 'after_4pm_et');
    assert.deepEqual(sent, []);
    assert.deepEqual(fcm, []);
  });

  it('simulation never sends and still reports the draft', async () => {
    const sent = [];
    const fcm = [];
    const out = await handleEarlyCheckinNotice({
      event: readyEvent({ simulate: true }),
      hospitableClient: airbnbClient(JAMIE, {
        sendMessageToReservation: async () => sent.push('hospitable'),
      }),
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      notifyOwner: async (n) => fcm.push(n),
      now: atEt(11, 0),
    });
    assert.equal(out.sent, false);
    assert.equal(out.sendSkipReason, 'simulation');
    assert.equal(out.decision.send, true);
    assert.match(out.proposedResponse, /Hi Jamie,/);
    assert.deepEqual(sent, []);
    assert.equal(fcm.length, 1);
    assert.match(fcm[0].title, /sim/i);
  });

  it('skips when nobody is checking in today', async () => {
    const sent = [];
    const fcm = [];
    const out = await handleEarlyCheckinNotice({
      event: readyEvent(),
      hospitableClient: {
        getReservations: async () => [],
        sendMessageToReservation: async () => sent.push('x'),
      },
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      notifyOwner: async (n) => fcm.push(n),
      now: atEt(11, 0),
    });
    assert.equal(out.sent, false);
    assert.equal(out.decision.reason, 'no_checkin_today');
    assert.deepEqual(sent, []);
    assert.deepEqual(fcm, []);
  });

  it('does not resend when the thread already has the unit-ready line', async () => {
    const sent = [];
    const fcm = [];
    const out = await handleEarlyCheckinNotice({
      event: readyEvent(),
      hospitableClient: airbnbClient(JAMIE, {
        messages: [
          {
            body: fillUnitReadyTemplate('Jamie'),
          },
        ],
        sendMessageToReservation: async () => sent.push('hospitable'),
      }),
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      notifyOwner: async (n) => fcm.push(n),
      now: atEt(11, 0),
    });
    assert.equal(out.sent, false);
    assert.equal(out.sendSkipReason, 'already_sent');
    assert.deepEqual(sent, []);
    assert.deepEqual(fcm, []);
  });

  it('records the send on the cleaning row after a real Airbnb delivery', async () => {
    const sent = [];
    const updates = [];
    const ddbClient = {
      send: async (cmd) => {
        updates.push(cmd);
        return {};
      },
    };
    const out = await handleEarlyCheckinNotice({
      event: readyEvent(),
      hospitableClient: airbnbClient(JAMIE, {
        sendMessageToReservation: async (id, body) => sent.push({ id, body }),
      }),
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      ddbClient,
      notifyOwner: async () => {},
      now: atEt(11, 0),
    });
    assert.equal(out.sent, true);
    assert.equal(updates.length, 1);
    const input = updates[0].input;
    assert.equal(input.TableName, 'cleaning');
    assert.equal(input.Key.listingIdAndDate, `${LISTING_APT2}_2026-08-26`);
    assert.match(input.UpdateExpression, /earlyCheckinSentAt/);
    assert.equal(input.ExpressionAttributeValues[':rid'], 'res-apt2');
  });

  it('noon vacant sends to the HE guest when they are the next check-in and last night was vacant', async () => {
    const sent = [];
    const out = await handleEarlyCheckinNotice({
      event: noonEvent(),
      hospitableClient: {
        getReservations: async () => [],
        sendMessageToReservation: async () => sent.push('hospitable'),
      },
      homeExchangeClient: heClient(KATIE, {
        sendMessage: async (id, body) => sent.push({ platform: 'he', id, body }),
      }),
      ddbClient: uncleanedDdb(null),
      notifyOwner: async () => {},
      now: atEt(12, 0),
    });
    assert.equal(out.source, 'noon_vacant');
    assert.equal(out.sent, true);
    assert.equal(out.recipient.platform, 'homeexchange');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].platform, 'he');
    assert.match(sent[0].body, /Hi Katie,/);
  });

  it('noon vacant does not send when an Airbnb guest is checking out today', async () => {
    const sent = [];
    const fcm = [];
    const departing = {
      id: 'res-out',
      conversation_id: 'conv-out',
      check_in: '2026-08-24',
      check_out: '2026-08-26',
      platform: { name: 'airbnb' },
      guest: { first_name: 'Jamie', last_name: 'Guest' },
      properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
    };
    const arriving = {
      id: 'res-in',
      conversation_id: 'conv-in',
      check_in: '2026-08-26',
      check_out: '2026-08-28',
      platform: { name: 'airbnb' },
      guest: { first_name: 'Sam', last_name: 'In' },
      properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
    };
    const out = await handleEarlyCheckinNotice({
      event: noonEvent(),
      hospitableClient: {
        getReservations: async () => [departing, arriving],
        sendMessageToReservation: async () => sent.push('hospitable'),
      },
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      ddbClient: uncleanedDdb(null),
      notifyOwner: async (n) => fcm.push(n),
      now: atEt(12, 0),
    });
    assert.equal(out.sent, false);
    assert.equal(out.decision.reason, 'checkout_today');
    assert.deepEqual(sent, []);
    assert.deepEqual(fcm, []);
  });

  it('noon vacant does not send when the unit is still in uncleanedUnits', async () => {
    const sent = [];
    const fcm = [];
    const out = await handleEarlyCheckinNotice({
      event: noonEvent(),
      hospitableClient: airbnbClient(JAMIE, {
        sendMessageToReservation: async () => sent.push('hospitable'),
      }),
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      ddbClient: uncleanedDdb({ listingId: LISTING_APT2, needed: true }),
      notifyOwner: async (n) => fcm.push(n),
      now: atEt(12, 0),
    });
    assert.equal(out.sent, false);
    assert.equal(out.decision.reason, 'uncleaned_unit');
    assert.deepEqual(sent, []);
    assert.deepEqual(fcm, []);
  });

  it('post-cleaning still sends when there is a same-day checkout (turnover)', async () => {
    const sent = [];
    const departing = {
      id: 'res-out',
      conversation_id: 'conv-out',
      check_in: '2026-08-24',
      check_out: '2026-08-26',
      platform: { name: 'airbnb' },
      guest: { first_name: 'Jamie', last_name: 'Guest' },
      properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
    };
    const arriving = {
      id: 'res-in',
      conversation_id: 'conv-in',
      check_in: '2026-08-26',
      check_out: '2026-08-28',
      platform: { name: 'airbnb' },
      guest: { first_name: 'Sam', last_name: 'In' },
      properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
    };
    const out = await handleEarlyCheckinNotice({
      event: readyEvent(),
      hospitableClient: {
        getReservations: async () => [departing, arriving],
        getReservationMessages: async () => [],
        sendMessageToReservation: async (id, body) => sent.push({ id, body }),
      },
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      notifyOwner: async () => {},
      now: atEt(12, 0),
    });
    assert.equal(out.source, 'cleaning');
    assert.equal(out.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'res-in');
    assert.match(sent[0].body, /Hi Sam,/);
  });

  it('noon vacant stays silent (no FCM) when nobody is checking in today', async () => {
    const sent = [];
    const fcm = [];
    const out = await handleEarlyCheckinNotice({
      event: noonEvent(),
      hospitableClient: {
        getReservations: async () => [],
        sendMessageToReservation: async () => sent.push('x'),
      },
      homeExchangeClient: {
        listConversations: async () => ({ data: { conversations: { edges: [] } } }),
      },
      ddbClient: uncleanedDdb(null),
      notifyOwner: async (n) => fcm.push(n),
      now: atEt(12, 0),
    });
    assert.equal(out.sent, false);
    assert.equal(out.decision.reason, 'no_checkin_today');
    assert.deepEqual(sent, []);
    assert.deepEqual(fcm, []);
  });

  it('owner FCM after a real send names the guest and unit', () => {
    const n = buildEarlyCheckinGuestNotify({
      simulate: false,
      decision: { reason: 'next_checkin_airbnb', send: true },
      recipients: [JAMIE],
      listingId: LISTING_APT2,
      listingName: 'Pine Apt #2',
      sent: true,
      sentCount: 1,
    });
    assert.match(n.title, /message sent to Jamie/);
    assert.match(n.body, /Pine Apt #2/);
    assert.equal(n.data.type, 'early_checkin_guest_notice');
    assert.equal(n.data.reservationId, 'res-apt2');
    assert.equal(n.data.conversationId, 'conv-apt2');
    assert.equal(n.data.platform, 'hospitable');
  });

  it('owner FCM points at the guest thread that was actually sent', () => {
    const n = buildEarlyCheckinGuestNotify({
      simulate: false,
      decision: { reason: 'next_checkin_airbnb_and_he', send: true },
      recipients: [JAMIE, KATIE],
      openRecipient: KATIE,
      listingId: LISTING_APT2,
      listingName: 'Pine Apt #2',
      sent: true,
      sentCount: 1,
    });
    assert.match(n.title, /message sent to Katie/);
    assert.equal(n.data.platform, 'homeexchange');
    assert.equal(n.data.conversationId, '95101669');
    assert.equal(n.data.reservationId, '');
  });

  it('does not build an owner FCM for expected unit-ready skips', () => {
    const skipped = buildEarlyCheckinGuestNotify({
      simulate: false,
      decision: { send: false, reason: 'no_checkin_today' },
      recipients: [],
      listingId: LISTING_APT2,
      listingName: 'Pine Apt #2',
      sent: false,
      sendSkipReason: 'no_checkin_today',
    });
    assert.equal(skipped, null);

    const already = buildEarlyCheckinGuestNotify({
      simulate: false,
      decision: { send: true, reason: 'next_checkin_airbnb' },
      recipients: [JAMIE],
      listingId: LISTING_APT2,
      listingName: 'Pine Apt #2',
      sent: false,
      sendSkipReason: 'already_sent',
    });
    assert.equal(already, null);

    const after4 = buildEarlyCheckinGuestNotify({
      simulate: false,
      decision: { send: false, reason: 'after_4pm_et' },
      recipients: [],
      listingId: LISTING_APT2,
      listingName: 'Pine Apt #2',
      sent: false,
      sendSkipReason: 'after_4pm_et',
    });
    assert.equal(after4, null);
  });

  it('still notifies the owner when the guest send fails', () => {
    const n = buildEarlyCheckinGuestNotify({
      simulate: false,
      decision: { send: true, reason: 'next_checkin_airbnb' },
      recipients: [JAMIE],
      listingId: LISTING_APT2,
      listingName: 'Pine Apt #2',
      sent: false,
      sendError: 'hospitable_timeout',
    });
    assert.match(n.title, /failed/i);
    assert.match(n.body, /hospitable_timeout/);
  });
});
