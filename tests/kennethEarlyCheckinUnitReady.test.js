import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import {
  alreadyHandledEarlyCheckinOnThread,
  alreadySentUnitReadyNotice,
  extractEarlyCheckinNoticeContext,
  fillUnitReadyTemplate,
  LISTING_APT2,
} from '../src/useCases/earlyCheckinOccupancy.js';
import { handleEarlyCheckinNotice } from '../src/useCases/earlyCheckinNotice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

/** Kenneth · 1875 West End Victorian (Apt #2) · Sep 22–25 2026 */
const KENNETH_MSG =
  'Jerome, is it possible to check in early? We should arrive around 3pm. Thanks, Kenn Shurtluff';

const CONSERVATIVE_REPLY =
  "Good afternoon, Kenneth. Check-in is at 4pm so we can't guarantee an arrival around 3pm, but as soon as cleaning finishes getting the unit ready for you we'll message you right away.";

const kennethReadyCtx = {
  guestName: 'Kenneth',
  checkIn: '2026-09-22T16:00:00-04:00',
  checkOut: '2026-09-25T10:00:00-04:00',
  listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
  airbnbListingId: '20150380',
  propertyName: '1875 West End Victorian | EV Charging + Parking',
  asOfDate: '2026-09-22',
  asOfInstant: '2026-09-22T13:50:00-04:00',
  nowForGreeting: '2026-09-22T13:50:00-04:00',
  conversationTraces: { earlyUnitReadyOffered: false },
  unitReadiness: {
    isUnitReady: true,
    buttonPressed: false,
    hadPreviousDayGuests: false,
    uncleanedPending: false,
  },
  uncleanedPending: false,
};

const kennethNotReadyCtx = {
  ...kennethReadyCtx,
  unitReadiness: {
    isUnitReady: false,
    buttonPressed: false,
    hadPreviousDayGuests: true,
    uncleanedPending: false,
  },
};

const kennethUncleanedCtx = {
  ...kennethReadyCtx,
  unitReadiness: {
    isUnitReady: false,
    buttonPressed: false,
    hadPreviousDayGuests: false,
    uncleanedPending: true,
  },
  uncleanedPending: true,
};

function agentForTests() {
  return new GuestMessagingAgent({
    projectRoot: projectRootForTests,
    llmAdapter: { complete: async () => '{}' },
  });
}

describe('Kenneth early check-in — vacant + clean → unit ready (Apt #2)', () => {
  it('detects Kenneth early-arrival ask', () => {
    const agent = agentForTests();
    assert.equal(agent._isEarlyCheckinAsk(KENNETH_MSG), true);
  });

  it('empty night + no uncleaned → offers unit ready (not can\'t-guarantee 4pm)', () => {
    const agent = agentForTests();
    const applied = agent._applyEarlyCheckinReplyPolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: CONSERVATIVE_REPLY,
        shouldReply: true,
        confidence: 0.9,
      },
      kennethReadyCtx,
      KENNETH_MSG
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.match(applied.proposedResponse, /unit is ready for you to check in now/i);
    assert.doesNotMatch(applied.proposedResponse, /can'?t guarantee/i);
    assert.doesNotMatch(applied.proposedResponse, /cleaning finishes/i);
    assert.match(applied.proposedResponse, /Kenneth/);
  });

  it('prior-night guest / not ready → keeps conservative cleaning-finishes copy', () => {
    const agent = agentForTests();
    const applied = agent._applyEarlyCheckinReplyPolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: "I'll check with the cleaning team.",
        shouldReply: true,
      },
      kennethNotReadyCtx,
      KENNETH_MSG
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /4pm/i);
    assert.match(applied.proposedResponse, /cleaning finishes|message you/i);
    assert.doesNotMatch(applied.proposedResponse, /unit is ready for you to check in now/i);
  });

  it('uncleanedUnits pending → keeps conservative (never claim ready)', () => {
    const agent = agentForTests();
    const applied = agent._applyEarlyCheckinReplyPolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: CONSERVATIVE_REPLY,
        shouldReply: true,
      },
      kennethUncleanedCtx,
      KENNETH_MSG
    );
    assert.equal(applied.applied, false); // already strong conservative — leave alone
    // Force weak draft path:
    const applied2 = agent._applyEarlyCheckinReplyPolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: "I'll check with the cleaning team.",
        shouldReply: true,
      },
      kennethUncleanedCtx,
      KENNETH_MSG
    );
    assert.equal(applied2.applied, true);
    assert.doesNotMatch(applied2.proposedResponse, /unit is ready for you to check in now/i);
    assert.match(applied2.proposedResponse, /4pm|cleaning finishes/i);
  });
});

describe('Noon vacant SQS envelope — nested body listingId (Kenneth miss)', () => {
  it('extracts listingId from API-Gateway-in-SQS double-encoded body', () => {
    const inner = {
      id: `early_checkin_noon_${LISTING_APT2}_2026-09-22`,
      action: 'noon.vacant_unit_ready',
      data: {
        listingId: LISTING_APT2,
        listingName: 'Pine Apt #2',
        date: '2026-09-22',
        source: 'noon_vacant',
        eventAt: '2026-09-22T16:00:25.326Z',
        simulate: false,
        sendGuests: true,
      },
    };
    const sqsEvent = {
      Records: [
        {
          body: JSON.stringify({
            queryStringParameters: { act: 'early_checkin_notice' },
            body: JSON.stringify(inner),
          }),
        },
      ],
    };
    const ctx = extractEarlyCheckinNoticeContext(sqsEvent);
    assert.equal(ctx.listingId, LISTING_APT2);
    assert.equal(ctx.requireVacantOvernight, true);
    assert.equal(ctx.source, 'noon_vacant');
  });
});

describe('Early check-in dedup — one message max per stay', () => {
  it('treats unit-ready notice as already handled', () => {
    assert.equal(
      alreadyHandledEarlyCheckinOnThread([
        { sender_type: 'host', body: fillUnitReadyTemplate('Kenneth') },
      ]),
      true
    );
    assert.equal(alreadySentUnitReadyNotice([{ body: fillUnitReadyTemplate('Kenneth') }]), true);
  });

  it('treats conservative early-checkin host reply as already handled (skip noon)', () => {
    assert.equal(
      alreadyHandledEarlyCheckinOnThread([
        { sender_type: 'guest', body: KENNETH_MSG },
        { sender_type: 'host', body: CONSERVATIVE_REPLY },
      ]),
      true
    );
  });

  it('does not treat unrelated host chat as handled', () => {
    assert.equal(
      alreadyHandledEarlyCheckinOnThread([
        { sender_type: 'host', body: "You're welcome, Kenneth!" },
      ]),
      false
    );
  });

  it('noon vacant skips send when thread already has early-checkin reply', async () => {
    const guest = {
      firstName: 'Kenneth',
      listingId: LISTING_APT2,
      checkIn: '2026-09-22',
      checkOut: '2026-09-25',
      platform: 'hospitable',
      reservationId: '547e0f98-4e97-4517-9396-4372c4305881',
      conversationId: '7f0d5c5b-4966-4e3e-8403-c369311d2d78',
      guestName: 'Kenneth',
      propertyName: 'Pine Apt #2',
    };
    const event = {
      queryStringParameters: { act: 'early_checkin_notice' },
      body: JSON.stringify({
        id: `early_checkin_noon_${LISTING_APT2}_2026-09-22`,
        action: 'noon.vacant_unit_ready',
        data: {
          listingId: LISTING_APT2,
          listingName: 'Pine Apt #2',
          date: '2026-09-22',
          source: 'noon_vacant',
          eventAt: '2026-09-22T16:00:00Z',
          simulate: false,
          sendGuests: true,
        },
      }),
    };
    let sent = 0;
    const result = await handleEarlyCheckinNotice({
      event,
      now: new Date('2026-09-22T17:00:00Z'), // 1pm ET
      ddbClient: { send: async () => ({}) },
      hospitableClient: {
        getReservations: async () => [
          {
            id: guest.reservationId,
            conversation_id: guest.conversationId,
            check_in: guest.checkIn,
            check_out: guest.checkOut,
            platform: { name: 'airbnb' },
            guest: { first_name: 'Kenneth', last_name: 'Shurtluff' },
            properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
          },
        ],
        getReservationMessages: async () => [
          { sender_type: 'guest', body: KENNETH_MSG },
          { sender_type: 'host', body: CONSERVATIVE_REPLY },
        ],
        sendMessageToReservation: async () => {
          sent += 1;
        },
      },
      homeExchangeClient: {
        listConversations: async () => ({
          data: { conversations: { edges: [] } },
        }),
      },
    });
    assert.equal(result.decision.send, true);
    assert.equal(result.sent, false);
    assert.equal(sent, 0);
    assert.equal(result.deliveries?.[0]?.sendSkipReason, 'already_sent');
  });
});


describe('Noon vacant nested SQS — would send unit-ready when vacant+clean', () => {
  const LISTING = LISTING_APT2;
  const guest = {
    firstName: 'Kenneth',
    listingId: LISTING,
    checkIn: '2026-09-22',
    checkOut: '2026-09-25',
    platform: 'hospitable',
    reservationId: '547e0f98-4e97-4517-9396-4372c4305881',
    conversationId: '7f0d5c5b-4966-4e3e-8403-c369311d2d78',
    guestName: 'Kenneth',
    propertyName: 'Pine Apt #2',
  };

  /** Exact production envelope from 2026-09-22 noon CW (Apt #2). */
  function nestedNoonSqsEvent({ simulate = false } = {}) {
    const inner = {
      id: `early_checkin_noon_${LISTING}_2026-09-22`,
      action: 'noon.vacant_unit_ready',
      data: {
        listingId: LISTING,
        listingName: 'Pine Apt #2',
        date: '2026-09-22',
        source: 'noon_vacant',
        eventAt: '2026-09-22T16:00:25.326Z',
        instruction:
          'Noon vacant-overnight early check-in: send only if nobody is checking out today (Airbnb or HomeExchange) and the unit is not in uncleanedUnits. Message the guest checking in today on this listing.',
        simulate,
        sendGuests: true,
      },
    };
    return {
      Records: [
        {
          body: JSON.stringify({
            queryStringParameters: { act: 'early_checkin_notice' },
            body: JSON.stringify(inner),
          }),
        },
      ],
    };
  }

  it('nested body + empty early-checkin thread → sends unit-ready (not unknown_listing)', async () => {
    let sent = 0;
    let sentBody = '';
    const result = await handleEarlyCheckinNotice({
      event: nestedNoonSqsEvent(),
      now: new Date('2026-09-22T17:00:00Z'), // 1pm ET
      ddbClient: { send: async () => ({}) },
      hospitableClient: {
        getReservations: async () => [
          {
            id: guest.reservationId,
            conversation_id: guest.conversationId,
            check_in: guest.checkIn,
            check_out: guest.checkOut,
            platform: { name: 'airbnb' },
            guest: { first_name: 'Kenneth', last_name: 'Shurtluff' },
            properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
          },
        ],
        getReservationMessages: async () => [
          { sender_type: 'guest', body: 'Looking forward to our stay!' },
        ],
        sendMessageToReservation: async (_id, body) => {
          sent += 1;
          sentBody = body;
        },
      },
      homeExchangeClient: {
        listConversations: async () => ({
          data: { conversations: { edges: [] } },
        }),
      },
    });
    assert.equal(result.listingId, LISTING);
    assert.notEqual(result.decision?.reason, 'unknown_listing');
    assert.equal(result.decision.send, true);
    assert.equal(result.sent, true);
    assert.equal(sent, 1);
    assert.match(sentBody, /unit is ready for you to check in now/i);
    assert.match(sentBody, /Kenneth/);
  });

  it('nested body + prior reactive early-checkin → already_sent (dedup OK)', async () => {
    let sent = 0;
    const result = await handleEarlyCheckinNotice({
      event: nestedNoonSqsEvent(),
      now: new Date('2026-09-22T17:00:00Z'),
      ddbClient: { send: async () => ({}) },
      hospitableClient: {
        getReservations: async () => [
          {
            id: guest.reservationId,
            conversation_id: guest.conversationId,
            check_in: guest.checkIn,
            check_out: guest.checkOut,
            platform: { name: 'airbnb' },
            guest: { first_name: 'Kenneth', last_name: 'Shurtluff' },
            properties: [{ id: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }],
          },
        ],
        getReservationMessages: async () => [
          { sender_type: 'guest', body: KENNETH_MSG },
          { sender_type: 'host', body: CONSERVATIVE_REPLY },
        ],
        sendMessageToReservation: async () => {
          sent += 1;
        },
      },
      homeExchangeClient: {
        listConversations: async () => ({
          data: { conversations: { edges: [] } },
        }),
      },
    });
    assert.equal(result.listingId, LISTING);
    assert.equal(result.decision.send, true);
    assert.equal(result.sent, false);
    assert.equal(sent, 0);
    assert.equal(result.deliveries?.[0]?.sendSkipReason, 'already_sent');
  });
});
