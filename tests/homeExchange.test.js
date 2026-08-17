import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isHomeExchangePayload,
  extractHomeExchangeMessage,
  resolveHeUnit,
  extractHeHomeId,
  isFirstHomeExchangeMessage,
  stayNights,
  analyzeCalendarOpen,
  buildHomeExchangeDraft,
  handleHomeExchangeMessage,
  shouldSendHomeExchangeDraft,
  shouldAttemptPreapprove,
  extractAskedStayDates,
  extractFormattedStayRange,
  extractPriorPreapprovalStay,
  extraNightsOf,
  isStayExtensionOf,
  guestAcceptedCleaningFee,
  guestAcceptedCleaningFeeInThread,
  guestAskedToPreapprove,
  analyzeHeCalendarOpen,
  mergeStayCalendars,
  HOMEEXCHANGE_ACT,
  HOMEEXCHANGE_PLATFORM,
  APT3_AIRBNB_LISTING_ID,
} from '../src/useCases/homeExchange.js';
import {
  isHeSharedThankYouMessage,
  isHeCheckoutTimeQuestion,
  isHeCheckinTimeQuestion,
  buildDeterministicHeSharedDraft,
  shouldRunSharedHeCategories,
  isAirbnbOnlyHeCategory,
  thisTurnWantsHePreapprove,
  guestAskedToAddNights,
  threadHasCancelledPreapproval,
  guestResubmittedAfterHeCancel,
} from '../src/useCases/homeExchangeSharedCategories.js';
import {
  applyHeFirstAckWriter,
  buildHeFirstAckClause,
  composeHeFirstReply,
  extractHeFirstMessageHooks,
  isSafeHeFirstAck,
} from '../src/useCases/homeExchangeFirstAck.js';
import { alreadySentEquivalent } from '../src/clients/HomeExchangeClient.js';
import { shouldUnblockPreapproval, canUnblockCalendarDay } from '../src/useCases/homeExchangeExpire.js';
import { exchangeAlreadyApproved } from '../src/clients/homeExchangeExchange.js';
import {
  buildHeAutoReplyNotify,
  buildHePreapprovalNotify,
  HE_NOTIFY_READY,
  HE_NOTIFY_SENT,
  HE_NOTIFY_SEND_FAILED,
} from '../src/useCases/homeExchangeNotify.js';

function heOpenRange(start, end) {
  return [{ start_on: start, end_on: end, type: 'NON_RECIPROCAL' }];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const valentinaPath = path.resolve(__dirname, '../test-payloads/valentina-okay-perfect-sqs.json');

describe('HomeExchange detector isolation (must not match Airbnb traffic)', () => {
  it('does not treat Hospitable act=message / platform=airbnb as HomeExchange', () => {
    const valentina = JSON.parse(readFileSync(valentinaPath, 'utf8'));
    assert.equal(isHomeExchangePayload(valentina), false);

    const hospitableSqs = {
      Records: [
        {
          body: JSON.stringify({
            queryStringParameters: { act: 'message' },
            body: JSON.stringify({
              id: 'webhook-1',
              data: {
                body: 'Thanks!',
                platform: 'airbnb',
                source: 'platform',
                listing: { platform: 'airbnb', platform_id: '24259977' },
                sender_type: 'guest',
              },
            }),
          }),
        },
      ],
    };
    assert.equal(isHomeExchangePayload(hospitableSqs), false);
  });

  it('does not treat reservation lifecycle or calendar-sync acts as HE chat', () => {
    assert.equal(
      isHomeExchangePayload({ queryStringParameters: { act: 'reservation' } }),
      false
    );
    assert.equal(
      isHomeExchangePayload({ queryStringParameters: { act: 'new_reservation_home_exchange' } }),
      false
    );
  });

  it('matches only explicit HomeExchange chat payloads', () => {
    assert.equal(
      isHomeExchangePayload({ queryStringParameters: { act: HOMEEXCHANGE_ACT } }),
      true
    );
    assert.equal(
      isHomeExchangePayload({
        Records: [
          {
            body: JSON.stringify({
              queryStringParameters: { act: HOMEEXCHANGE_ACT },
              body: JSON.stringify({
                data: { body: 'Hi', platform: HOMEEXCHANGE_PLATFORM },
              }),
            }),
          },
        ],
      }),
      true
    );
    assert.equal(
      isHomeExchangePayload({
        message: 'Hi',
        context: { platform: HOMEEXCHANGE_PLATFORM },
      }),
      true
    );
  });
});

describe('HomeExchange unit mapping (Katie Apt #2 wiring)', () => {
  it('maps HE home 3285044 to Apt #2 Hospitable + Airbnb ids', () => {
    const unit = resolveHeUnit('3285044');
    assert.equal(unit.propertyId, '114663c5-0709-4eff-a868-fa9ebd6ed42d');
    assert.equal(unit.airbnbListingId, '20150380');
    assert.equal(unit.propertyName, 'Pine Apt #2');
    assert.equal(extractHeHomeId({ listing: { platform_id: '3285044' } }), '3285044');
  });

  it('prefers HE home id over a hardcoded Apt #3 property on the payload', () => {
    const extracted = extractHomeExchangeMessage({
      queryStringParameters: { act: HOMEEXCHANGE_ACT },
      body: JSON.stringify({
        data: {
          body: 'Halloween weekend',
          platform: HOMEEXCHANGE_PLATFORM,
          listing: { platform: 'homeexchange', platform_id: '3285044' },
          property: { id: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd', name: 'Pine Apt #3' },
          airbnbListingId: '24259977',
          checkIn: '2026-10-29',
          checkOut: '2026-11-02',
        },
      }),
    });
    assert.equal(extracted.context.homeId, '3285044');
    assert.equal(extracted.context.listingId, '114663c5-0709-4eff-a868-fa9ebd6ed42d');
    assert.equal(extracted.context.airbnbListingId, '20150380');
    assert.equal(extracted.context.propertyName, 'Pine Apt #2');
  });

  it('checks Apt #2 Hospitable calendar even when payload property is Apt #3', async () => {
    const calendarIds = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'Halloween weekend in Portland',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: true,
          guestName: 'Katie',
          checkIn: '2026-10-29',
          checkOut: '2026-11-02',
          listing: { platform: 'homeexchange', platform_id: '3285044' },
          listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
          airbnbListingId: '24259977',
          property: { id: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd', name: 'Pine Apt #3' },
        },
      },
      hospitableClient: {
        async getPropertyCalendar(propertyId) {
          calendarIds.push(propertyId);
          return ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map(
            (date) => ({ date, status: { available: true } })
          );
        },
        async getPropertyReservations() {
          return [];
        },
      },
      ddbClient: {
        async send() {
          return { Item: { listingId: 20150380, name: 'Pine Apt #2', price: 120 } };
        },
      },
      homeExchangeClient: {
        async getHomeCalendar(homeId) {
          assert.equal(String(homeId), '3285044');
          return heOpenRange('2026-10-25', '2026-11-05');
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    });
    assert.deepEqual(calendarIds, ['114663c5-0709-4eff-a868-fa9ebd6ed42d']);
    assert.equal(result.homeId, '3285044');
    assert.equal(result.propertyId, '114663c5-0709-4eff-a868-fa9ebd6ed42d');
    assert.equal(result.airbnbListingId, '20150380');
    assert.equal(result.calendar.open, true);
    assert.equal(result.cleaningFee.amount, 120);
    assert.match(result.proposedResponse, /\$120/);
    assert.match(result.proposedResponse, /open on our calendar/i);
    assert.match(result.proposedResponse, /okay paying that after your stay/i);
    assert.match(result.proposedResponse, /Halloween/i);
    assert.match(result.proposedResponse, /Portland/i);
  });
});

describe('HomeExchange first-message policy (deterministic, no LLM)', () => {
  const caroline =
    'Hi Ruby, your place looks great. We are asking for a points exchange visit checking in May 13 and checking out May 19 for 6 nights. Our grandchildren live just on the other side of Deering Park. It is ideal for us. I know it’s way out next May, but we have people staying in our home with Home Exchange. Look forward to hearing from you. Caroline & Ken.';

  it('computes 6 stay nights for May 13–19', () => {
    const nights = stayNights('2027-05-13', '2027-05-19');
    assert.deepEqual(nights, [
      '2027-05-13',
      '2027-05-14',
      '2027-05-15',
      '2027-05-16',
      '2027-05-17',
      '2027-05-18',
    ]);
  });

  it('treats message_count=1 / isFirstMessage as first HE message', () => {
    assert.equal(isFirstHomeExchangeMessage({ isFirstMessage: true }), true);
    assert.equal(isFirstHomeExchangeMessage({ messageCount: 1 }), true);
    assert.equal(isFirstHomeExchangeMessage({ isFirstMessage: false }), false);
  });

  it('asks for the DDB cleaning fee only when the calendar is open', () => {
    const open = analyzeCalendarOpen({
      calendarDays: [
        { date: '2027-05-13', status: { available: true } },
        { date: '2027-05-14', status: { available: true } },
        { date: '2027-05-15', status: { available: true } },
        { date: '2027-05-16', status: { available: true } },
        { date: '2027-05-17', status: { available: true } },
        { date: '2027-05-18', status: { available: true } },
        { date: '2027-05-19', status: { available: true } },
      ],
      reservations: [],
      checkIn: '2027-05-13',
      checkOut: '2027-05-19',
    });
    assert.equal(open.open, true);

    const draft = buildHomeExchangeDraft({
      guestName: 'Caroline',
      guestMessage: caroline,
      checkIn: '2027-05-13',
      checkOut: '2027-05-19',
      calendar: open,
      cleaningFee: { amount: 125, source: 'ddb_listing', listingId: APT3_AIRBNB_LISTING_ID },
      isFirst: true,
    });
    assert.equal(draft.typeOfMessageReceived, 'HOMEEXCHANGE_FIRST_MESSAGE');
    assert.equal(draft.shouldReply, true);
    assert.match(draft.proposedResponse, /Caroline/);
    assert.match(draft.proposedResponse, /\$125/);
    assert.match(draft.proposedResponse, /after your stay/i);
    assert.match(draft.proposedResponse, /open on our calendar/i);
    assert.match(draft.proposedResponse, /grandchildren/i);
    assert.match(draft.proposedResponse, /Deering Park/i);
    assert.match(draft.proposedResponse, /kind words about the place/i);
  });

  it('does not ask for a cleaning fee when the calendar is blocked', () => {
    const blocked = analyzeCalendarOpen({
      calendarDays: [
        { date: '2027-05-13', status: { available: false } },
        { date: '2027-05-14', status: { available: true } },
        { date: '2027-05-15', status: { available: true } },
        { date: '2027-05-16', status: { available: true } },
        { date: '2027-05-17', status: { available: true } },
        { date: '2027-05-18', status: { available: true } },
      ],
      reservations: [],
      checkIn: '2027-05-13',
      checkOut: '2027-05-19',
    });
    assert.equal(blocked.open, false);

    const draft = buildHomeExchangeDraft({
      guestName: 'Caroline',
      guestMessage: caroline,
      checkIn: '2027-05-13',
      checkOut: '2027-05-19',
      calendar: blocked,
      cleaningFee: { amount: 125 },
      isFirst: true,
    });
    assert.match(draft.proposedResponse, /not open/i);
    assert.match(draft.proposedResponse, /grandchildren/i);
    assert.equal(/\$125/.test(draft.proposedResponse), false);
    assert.equal(/paying that/.test(draft.proposedResponse), false);
  });

  it('treats an accepted Hospitable reservation as blocking even if calendar looks open', () => {
    const result = analyzeCalendarOpen({
      calendarDays: [
        { date: '2027-05-13', available: true },
        { date: '2027-05-14', available: true },
        { date: '2027-05-15', available: true },
        { date: '2027-05-16', available: true },
        { date: '2027-05-17', available: true },
        { date: '2027-05-18', available: true },
      ],
      reservations: [
        {
          id: 'res-1',
          status: 'accepted',
          check_in: '2027-05-16',
          check_out: '2027-05-18',
        },
      ],
      checkIn: '2027-05-13',
      checkOut: '2027-05-19',
    });
    assert.equal(result.open, false);
    assert.ok(result.unavailable.includes('2027-05-16'));
    assert.ok(result.unavailable.includes('2027-05-17'));
  });

  it('does not draft a generic follow-up with no fee/date ask', () => {
    const draft = buildHomeExchangeDraft({
      guestName: 'Caroline',
      isFirst: false,
    });
    assert.equal(draft.typeOfMessageReceived, 'HOMEEXCHANGE_FOLLOWUP');
    assert.equal(draft.shouldReply, false);
    assert.equal(draft.proposedResponse, null);
    assert.equal(shouldSendHomeExchangeDraft(draft, false), false);
  });

  it('parses Caroline Sep 30–Oct 3 as 2026 from mid-August 2026', () => {
    const carolineFollowup =
      'Hi Ruby, the cleaning fee is fine. Just out of curiosity, we are also planning to visit our grandkids September 30- October 3, and is your place available?';
    assert.equal(guestAcceptedCleaningFee(carolineFollowup), true);
    const dates = extractAskedStayDates(carolineFollowup, {
      now: new Date('2026-08-14T12:00:00Z'),
    });
    assert.deepEqual(dates, {
      checkIn: '2026-09-30',
      checkOut: '2026-10-03',
      yearSource: 'inferred',
    });
    const later = extractAskedStayDates('September 30- October 3', {
      now: new Date('2026-10-04T12:00:00Z'),
    });
    assert.equal(later.checkIn, '2027-09-30');
    assert.equal(later.checkOut, '2027-10-03');
  });

  it('runs Caroline first-message SQS shape and sends via HomeExchange (not Hospitable)', async () => {
    const event = {
      Records: [
        {
          body: JSON.stringify({
            queryStringParameters: { act: HOMEEXCHANGE_ACT },
            body: JSON.stringify({
              id: 'he-293953795',
              action: 'homeexchange.message.created',
              data: {
                body: caroline,
                conversation_id: '95101669',
                platform: HOMEEXCHANGE_PLATFORM,
                source: HOMEEXCHANGE_PLATFORM,
                sender_type: 'guest',
                sender: { type: 'guest', first_name: 'Caroline' },
                guestName: 'Caroline',
                checkIn: '2027-05-13',
                checkOut: '2027-05-19',
                isFirstMessage: true,
                messageCount: 1,
                airbnbListingId: APT3_AIRBNB_LISTING_ID,
              },
            }),
          }),
        },
      ],
    };

    const extracted = extractHomeExchangeMessage(event);
    assert.equal(extracted.context.platform, HOMEEXCHANGE_PLATFORM);
    assert.match(extracted.message, /Caroline & Ken/);

    const hospitableClient = {
      async getPropertyCalendar() {
        return [
          '2027-05-13',
          '2027-05-14',
          '2027-05-15',
          '2027-05-16',
          '2027-05-17',
          '2027-05-18',
          '2027-05-19',
        ].map((date) => ({ date, status: { available: true } }));
      },
      async getPropertyReservations() {
        return [];
      },
    };
    const ddbClient = {
      async send() {
        return { Item: { listingId: 24259977, name: 'Pine Apt #3', price: 125 } };
      },
    };
    const sentBodies = [];
    const notifications = [];
    const homeExchangeClient = {
      async listMessages() {
        return [{ content: caroline, author: { first_name: 'Caroline' } }];
      },
      async getHomeCalendar() {
        return heOpenRange('2027-01-04', '2027-06-01');
      },
      async sendMessage(conversationId, content) {
        sentBodies.push({ conversationId, content });
        return { ok: true };
      },
    };

    const result = await handleHomeExchangeMessage({
      event,
      hospitableClient,
      ddbClient,
      homeExchangeClient,
      notifyOwner: async (payload) => {
        notifications.push(payload);
        return { ok: true };
      },
    });
    assert.equal(result.sendDisabled, false);
    assert.equal(result.sent, true);
    assert.equal(sentBodies.length, 1);
    assert.equal(String(sentBodies[0].conversationId), '95101669');
    assert.match(sentBodies[0].content, /\$125/);
    assert.equal(result.isFirstMessage, true);
    assert.equal(result.shouldReply, true);
    assert.equal(result.cleaningFee.amount, 125);
    assert.equal(result.cleaningFee.source, 'ddb_listing');
    assert.equal(result.calendar.open, true);
    assert.match(result.proposedResponse, /\$125/);
    assert.match(result.proposedResponse, /after your stay/i);
    assert.match(result.proposedResponse, /grandchildren/i);
    assert.match(result.proposedResponse, /Deering Park/i);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, HE_NOTIFY_SENT);
    assert.match(notifications[0].title, /Caroline/);
    assert.match(notifications[0].body, /\$125/);
    assert.equal(notifications[0].data.conversationId, '95101669');
  });

  it('never calls Hospitable send APIs from the HE use case', async () => {
    let sendCalled = false;
    const hospitableClient = {
      async getPropertyCalendar() {
        return [];
      },
      async getPropertyReservations() {
        return [];
      },
      async sendMessage() {
        sendCalled = true;
      },
      async sendMessageToReservation() {
        sendCalled = true;
      },
    };
    await handleHomeExchangeMessage({
      event: {
        message: 'Hi',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: true,
          checkIn: '2027-05-13',
          checkOut: '2027-05-19',
          guestName: 'Caroline',
        },
      },
      hospitableClient,
      ddbClient: { async send() { return {}; } },
    });
    assert.equal(sendCalled, false);
  });

  it('sends a shared thank-you on HE follow-up (does not re-run pre-approve)', async () => {
    const sentBodies = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'Thank you. Coming your way!',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
          checkIn: '2027-05-13',
          checkOut: '2027-05-19',
          conversationHistory: [
            { sender_type: 'guest', content: 'Hi Ruby, the cleaning fee is fine.' },
          ],
        },
      },
      homeExchangeClient: {
        async sendMessage(_id, content) {
          sentBodies.push(content);
        },
      },
    });
    assert.equal(result.sendDisabled, false);
    assert.equal(result.sent, true);
    assert.equal(result.preapprove.attempted, false);
    assert.equal(result.typeOfMessageReceived, 'THANK_YOU_MESSAGE');
    assert.equal(sentBodies[0], "You're welcome, Caroline!");
    assert.equal(result.reason, 'homeexchange_shared_thank_you');
  });

  it('does not send a non-category HE follow-up when no shared agent is present', async () => {
    let sent = 0;
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'Just thinking about our trip.',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
        },
      },
      homeExchangeClient: {
        async sendMessage() {
          sent += 1;
        },
      },
    });
    assert.equal(result.sendDisabled, true);
    assert.equal(result.sent, false);
    assert.equal(sent, 0);
    assert.equal(shouldSendHomeExchangeDraft(result, false), false);
  });

  it('sends Caroline fee-accepted + Sep 30–Oct 3 date check via HomeExchange', async () => {
    const carolineFollowup =
      'Hi Ruby, the cleaning fee is fine. Just out of curiosity, we are also planning to visit our grandkids September 30- October 3, and is your place available?';
    const priorFeeAsk =
      'Hi Caroline, thanks for your message — May 13–19, 2027 is open on our calendar, so we can accept the request.\n\nOne thing we ask for Home Exchange stays: the cleaning fee after you leave is $125. Would you be okay paying that after your stay?';
    let calendarRange = null;
    const sentBodies = [];
    const result = await handleHomeExchangeMessage({
      event: {
        Records: [
          {
            body: JSON.stringify({
              queryStringParameters: { act: HOMEEXCHANGE_ACT },
              body: JSON.stringify({
                data: {
                  body: carolineFollowup,
                  conversation_id: '95101669',
                  platform: HOMEEXCHANGE_PLATFORM,
                  source: HOMEEXCHANGE_PLATFORM,
                  sender_type: 'guest',
                  sender: { type: 'guest', first_name: 'Caroline' },
                  guestName: 'Caroline',
                  checkIn: '2027-05-13',
                  checkOut: '2027-05-19',
                  isFirstMessage: false,
                  messageCount: 2,
                  airbnbListingId: APT3_AIRBNB_LISTING_ID,
                },
              }),
            }),
          },
        ],
      },
      ddbClient: {
        async send() {
          return { Item: { listingId: 24259977, name: 'Pine Apt #3', price: 125 } };
        },
      },
      homeExchangeClient: {
        async listMessages() {
          return [{ content: priorFeeAsk }];
        },
        async getHomeCalendar() {
          return [
            ...heOpenRange('2026-09-30', '2026-10-03'),
            ...heOpenRange('2027-01-04', '2027-06-01'),
          ];
        },
        async getConversation() {
          return {
            exchanges: [
              {
                id: 127232869,
                status: 0,
                approved_at: null,
                start_on: '2027-05-13',
                end_on: '2027-05-19',
                home: { id: 3202475 },
              },
            ],
          };
        },
        async approveExchange() {
          return { ok: true };
        },
        async sendMessage(conversationId, content) {
          sentBodies.push({ conversationId, content });
        },
      },
      hospitableClient: {
        async getPropertyCalendar(_id, start, end) {
          calendarRange = { start, end };
          const days =
            start === '2027-05-13'
              ? ['2027-05-13', '2027-05-14', '2027-05-15', '2027-05-16', '2027-05-17', '2027-05-18', '2027-05-19']
              : ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'];
          return days.map((date) => ({ date, status: { available: true } }));
        },
        async getPropertyReservations() {
          return [];
        },
        async updatePropertyCalendar() {
          return { status: 'accepted' };
        },
      },
      blockStore: { async put() { return {}; } },
      notifyOwner: async () => ({ ok: true }),
      now: new Date('2026-08-14T12:00:00Z'),
    });
    assert.equal(result.isFirstMessage, false);
    assert.equal(result.feeAccepted, true);
    assert.equal(result.askedDates.checkIn, '2026-09-30');
    assert.equal(result.askedDates.checkOut, '2026-10-03');
    assert.equal(result.checkIn, '2026-09-30');
    assert.equal(result.checkOut, '2026-10-03');
    assert.equal(result.originalCheckIn, '2027-05-13');
    assert.equal(result.calendar.open, true);
    assert.ok(
      calendarRange &&
        (calendarRange.start === '2026-09-30' || calendarRange.start === '2027-05-13')
    );
    assert.equal(result.shouldReply, true);
    assert.equal(result.sendDisabled, false);
    assert.equal(result.sent, true);
    assert.equal(sentBodies.length, 1);
    assert.equal(String(sentBodies[0].conversationId), '95101669');
    assert.equal(shouldSendHomeExchangeDraft(result, false), true);
    assert.equal(alreadySentEquivalent([{ content: priorFeeAsk }], result.proposedResponse), false);
    assert.match(result.proposedResponse, /cleaning fee is fine/i);
    assert.match(result.proposedResponse, /May 13–19, 2027/);
    assert.match(result.proposedResponse, /pre-approval/i);
    assert.match(result.proposedResponse, /blocked those dates for you/i);
    assert.match(result.proposedResponse, /September 30 – October 3, 2026/);
    assert.match(result.proposedResponse, /also open/i);
    assert.match(result.proposedResponse, /\$125/);
    assert.equal(/you.?re booked/i.test(result.proposedResponse), false);
  });

  it('sends not-open follow-up date reply via HomeExchange', async () => {
    const sentBodies = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message:
          'Hi Ruby, the cleaning fee is fine. Just out of curiosity, we are also planning to visit our grandkids September 30- October 3, and is your place available?',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
          checkIn: '2027-05-13',
          checkOut: '2027-05-19',
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return [
            { date: '2026-09-30', status: { available: false } },
            { date: '2026-10-01', status: { available: true } },
            { date: '2026-10-02', status: { available: true } },
          ];
        },
        async getPropertyReservations() {
          return [];
        },
      },
      ddbClient: {
        async send() {
          return { Item: { listingId: 24259977, price: 125 } };
        },
      },
      homeExchangeClient: {
        async listMessages() {
          return [
            {
              content:
                'Hi Caroline, thanks for your message — May 13–19, 2027 is open on our calendar, so we can accept the request.\n\nOne thing we ask for Home Exchange stays: the cleaning fee after you leave is $125. Would you be okay paying that after your stay?',
            },
          ];
        },
        async getHomeCalendar() {
          return heOpenRange('2027-01-04', '2027-06-01');
        },
        async sendMessage(conversationId, content) {
          sentBodies.push({ conversationId, content });
        },
      },
      now: new Date('2026-08-14T12:00:00Z'),
    });
    assert.equal(result.sendDisabled, false);
    assert.equal(result.sent, true);
    assert.equal(result.calendar.open, false);
    assert.equal(sentBodies.length, 1);
    assert.match(result.proposedResponse, /not open/i);
    assert.match(result.proposedResponse, /cleaning fee is fine/i);
    assert.match(sentBodies[0].content, /not open/i);
  });

  it('skips send when the fee ask is already on the HE thread', async () => {
    let sent = 0;
    const draftText =
      'Hi Caroline, thanks for your message — May 13–19, 2027 is open on our calendar, so we can accept the request.\n\nOne thing we ask for Home Exchange stays: the cleaning fee after you leave is $125. Would you be okay paying that after your stay?';
    const result = await handleHomeExchangeMessage({
      event: {
        Records: [
          {
            body: JSON.stringify({
              queryStringParameters: { act: HOMEEXCHANGE_ACT },
              body: JSON.stringify({
                data: {
                  body: caroline,
                  conversation_id: '95101669',
                  platform: HOMEEXCHANGE_PLATFORM,
                  source: HOMEEXCHANGE_PLATFORM,
                  guestName: 'Caroline',
                  checkIn: '2027-05-13',
                  checkOut: '2027-05-19',
                  isFirstMessage: true,
                  airbnbListingId: APT3_AIRBNB_LISTING_ID,
                },
              }),
            }),
          },
        ],
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return [
            '2027-05-13',
            '2027-05-14',
            '2027-05-15',
            '2027-05-16',
            '2027-05-17',
            '2027-05-18',
          ].map((date) => ({ date, status: { available: true } }));
        },
        async getPropertyReservations() {
          return [];
        },
      },
      ddbClient: {
        async send() {
          return { Item: { listingId: 24259977, price: 125 } };
        },
      },
      homeExchangeClient: {
        async listMessages() {
          return [{ content: draftText }];
        },
        async getHomeCalendar() {
          return heOpenRange('2027-01-04', '2027-06-01');
        },
        async sendMessage() {
          sent += 1;
        },
      },
    });
    assert.equal(result.sent, false);
    assert.equal(result.sendSkipReason, 'already_sent');
    assert.equal(sent, 0);
    assert.equal(alreadySentEquivalent([{ content: draftText }], draftText), true);
  });

  it('does not treat the earlier fee-confirm host note as the pre-approval send', () => {
    const prior =
      'Hi Caroline — thanks for confirming the $125 cleaning fee is fine for May 13–19, 2027. We can accept that request.';
    const next =
      'Hi Caroline — thanks for confirming the $125 cleaning fee is fine for May 13–19, 2027. I just sent you a pre-approval for May 13–19, 2027 and blocked those dates for you.';
    assert.equal(alreadySentEquivalent([{ content: prior }], next), false);
    assert.equal(alreadySentEquivalent([{ content: next }], next), true);
  });

  it('does not treat a prior pre-approval as sent when the stay range changed', () => {
    const prior =
      'Hi Katie — thanks for confirming the $120 cleaning fee is fine for October 29 – November 2, 2026. I just sent you a pre-approval for October 29 – November 2, 2026 and blocked those dates for you.';
    const next =
      'Hi Katie — thanks for confirming the $120 cleaning fee is fine for October 29 – November 3, 2026. I checked the extra night of November 2, 2026 and that night is open. I just sent you a pre-approval for October 29 – November 3, 2026 and blocked those dates for you.';
    assert.equal(alreadySentEquivalent([{ content: prior }], next), false);
    assert.equal(alreadySentEquivalent([{ content: next }], next), true);
  });
});

describe('HomeExchange first-message personalization (Airbnb-style ack)', () => {
  const caroline =
    'Hi Ruby, your place looks great. We are asking for a points exchange visit checking in May 13 and checking out May 19 for 6 nights. Our grandchildren live just on the other side of Deering Park. It is ideal for us. I know it’s way out next May, but we have people staying in our home with Home Exchange. Look forward to hearing from you. Caroline & Ken.';
  const katie =
    'Hi! We would love to spend Halloween weekend in Portland with friends — your place looks great.';

  it('extracts Caroline grandchildren / Deering Park / compliment hooks', () => {
    const hooks = extractHeFirstMessageHooks(caroline);
    assert.equal(hooks.complimentPlace, true);
    assert.equal(hooks.family, 'grandchildren');
    assert.equal(hooks.landmark, 'Deering Park');
    const ack = buildHeFirstAckClause(caroline);
    assert.match(ack, /kind words about the place/i);
    assert.match(ack, /grandchildren/i);
    assert.match(ack, /Deering Park/i);
  });

  it('extracts Katie Halloween-in-Portland hooks', () => {
    const hooks = extractHeFirstMessageHooks(katie);
    assert.equal(hooks.occasion, 'Halloween');
    assert.equal(hooks.city, 'Portland');
    assert.equal(hooks.complimentPlace, true);
    const ack = buildHeFirstAckClause(katie);
    assert.match(ack, /Halloween/i);
    assert.match(ack, /Portland/i);
  });

  it('keeps a generic opener only for short hi/thanks first messages', () => {
    assert.equal(buildHeFirstAckClause('Hi'), 'thanks for reaching out');
    assert.equal(buildHeFirstAckClause('Thanks!'), 'thanks for reaching out');
    assert.equal(buildHeFirstAckClause(''), 'thanks for reaching out');
  });

  it('composes ack + policy without dropping the operational paragraph', () => {
    const text = composeHeFirstReply({
      guestName: 'Katie',
      ackClause: 'Halloween in Portland sounds like a fun trip',
      policySentence:
        'I checked our calendar for October 29–November 2, 2026 and those dates are not open, so we can\'t accept the request as it stands.',
    });
    assert.match(text, /^Hi Katie — Halloween in Portland sounds like a fun trip\./);
    assert.match(text, /those dates are not open/i);
    assert.equal(/\$120/.test(text), false);
  });

  it('declines Katie with a Halloween ack and no cleaning-fee ask', async () => {
    const result = await handleHomeExchangeMessage({
      event: {
        message: katie,
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: true,
          guestName: 'Katie',
          checkIn: '2026-10-29',
          checkOut: '2026-11-02',
          listing: { platform: 'homeexchange', platform_id: '3285044' },
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return [
            { date: '2026-10-29', status: { available: false } },
            { date: '2026-10-30', status: { available: true } },
            { date: '2026-10-31', status: { available: true } },
            { date: '2026-11-01', status: { available: true } },
          ];
        },
        async getPropertyReservations() {
          return [];
        },
      },
      homeExchangeClient: {
        async getHomeCalendar() {
          return heOpenRange('2027-01-04', '2027-06-01');
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    });
    assert.equal(result.calendar.open, false);
    assert.equal(result.reason, 'calendar_not_open');
    assert.match(result.proposedResponse, /Hi Katie/i);
    assert.match(result.proposedResponse, /Halloween/i);
    assert.match(result.proposedResponse, /Portland/i);
    assert.match(result.proposedResponse, /not open/i);
    assert.match(result.proposedResponse, /can't accept the request/i);
    assert.equal(/\$120/.test(result.proposedResponse), false);
    assert.equal(/after your stay/.test(result.proposedResponse), false);
  });

  it('rejects an ack writer that invents fees or availability', () => {
    assert.equal(isSafeHeFirstAck('Halloween in Portland sounds like a fun trip'), true);
    assert.equal(isSafeHeFirstAck('those dates are not open on our calendar'), false);
    assert.equal(isSafeHeFirstAck('the cleaning fee after you leave is $120'), false);
    assert.equal(isSafeHeFirstAck('Hi Katie, thanks for reaching out'), false);
    assert.equal(isSafeHeFirstAck('ok'), false);
  });

  it('uses a safe writer ack and ignores an unsafe one', async () => {
    const base = buildHomeExchangeDraft({
      guestName: 'Katie',
      guestMessage: katie,
      checkIn: '2026-10-29',
      checkOut: '2026-11-02',
      calendar: { checked: true, open: false, unavailable: ['2026-10-29'] },
      isFirst: true,
    });
    const good = await applyHeFirstAckWriter(base, {
      message: katie,
      guestName: 'Katie',
      writer: async () =>
        'Halloween weekend with friends in Portland sounds like a great trip, and thanks for the kind words about the place',
    });
    assert.equal(good.ackSource, 'writer');
    assert.match(good.proposedResponse, /with friends/i);
    assert.match(good.proposedResponse, /not open/i);

    const bad = await applyHeFirstAckWriter(base, {
      message: katie,
      guestName: 'Katie',
      writer: async () => 'those dates are open and the cleaning fee is $120',
    });
    assert.equal(bad.ackSource, 'hooks');
    assert.equal(bad.proposedResponse, base.proposedResponse);
  });

  it('treats a prior decline as already sent even if the ack wording changed', () => {
    const prior =
      'Hi Katie, thanks for reaching out. I checked our calendar for October 29–November 2, 2026 and those dates are not open, so we can\'t accept the request as it stands.';
    const next =
      'Hi Katie — Halloween in Portland sounds like a fun trip. I checked our calendar for October 29–November 2, 2026 and those dates are not open, so we can\'t accept the request as it stands.';
    assert.equal(alreadySentEquivalent([{ content: prior }], next), true);
  });
});

describe('HomeExchange HE calendar + pre-approve (no guest confirmation send)', () => {
  it('treats HE RESERVED / missing ranges as closed even if Hospitable is open', () => {
    const he = analyzeHeCalendarOpen({
      ranges: [{ start_on: '2026-06-01', end_on: '2026-09-01', type: 'RESERVED' }],
      checkIn: '2026-07-01',
      checkOut: '2026-07-05',
    });
    assert.equal(he.checked, true);
    assert.equal(he.open, false);
    const merged = mergeStayCalendars(
      {
        checked: true,
        open: true,
        nights: ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'],
        available: ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'],
        unavailable: [],
      },
      he
    );
    assert.equal(merged.open, false);
    assert.equal(merged.heOpen, false);
  });

  it('treats uncovered HE nights (long owner block) as closed', () => {
    const he = analyzeHeCalendarOpen({
      ranges: [{ start_on: '2027-01-04', end_on: '2027-06-01', type: 'NON_RECIPROCAL' }],
      checkIn: '2026-07-10',
      checkOut: '2026-07-15',
    });
    assert.equal(he.open, false);
    assert.ok(he.unavailable.includes('2026-07-10'));
  });

  it('sends a pre-approval note (not “you’re booked”) after fee accept + both calendars open', async () => {
    const notifications = [];
    const approved = [];
    const blocked = [];
    const stored = [];
    const sentBodies = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'Hi Ruby, the cleaning fee is fine.',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
          checkIn: '2027-05-13',
          checkOut: '2027-05-19',
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return [
            '2027-05-13',
            '2027-05-14',
            '2027-05-15',
            '2027-05-16',
            '2027-05-17',
            '2027-05-18',
          ].map((date) => ({ date, status: { available: true } }));
        },
        async getPropertyReservations() {
          return [];
        },
        async updatePropertyCalendar(_id, dates) {
          blocked.push(...dates);
          return { status: 'accepted' };
        },
      },
      ddbClient: {
        async send() {
          return { Item: { listingId: 24259977, price: 125 } };
        },
      },
      homeExchangeClient: {
        async getHomeCalendar() {
          return heOpenRange('2027-01-04', '2027-06-01');
        },
        async getConversation() {
          return {
            exchanges: [
              { id: 127232869, status: 0, approved_at: null, home: { id: 3202475 } },
            ],
          };
        },
        async approveExchange(id) {
          approved.push(id);
          return { ok: true };
        },
        async sendMessage(_id, content) {
          sentBodies.push(content);
          return { ok: true };
        },
      },
      blockStore: {
        async put(item) {
          stored.push(item);
          return item;
        },
      },
      notifyOwner: async (payload) => {
        notifications.push(payload);
        return { ok: true };
      },
    });
    assert.equal(result.feeAccepted, true);
    assert.equal(result.sendDisabled, false);
    assert.equal(result.sent, true);
    assert.equal(result.preapprove.ok, true);
    assert.deepEqual(approved, [127232869]);
    assert.equal(blocked.length, 6);
    assert.equal(blocked[0].available, false);
    assert.equal(blocked[0].date, '2027-05-13');
    assert.equal(blocked[5].date, '2027-05-18');
    assert.equal(stored[0].nights.length, 6);
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0].type, HE_NOTIFY_READY);
    assert.match(notifications[0].title, /Caroline/);
    assert.match(notifications[0].body, /Pre-approved on Home Exchange/i);
    assert.match(notifications[0].body, /invited to book/i);
    assert.match(notifications[0].body, /Pine Apt #3/);
    assert.equal(notifications[0].data.listingId, '24259977');
    assert.equal(/NOT sent/i.test(notifications[0].body), false);
    assert.equal(notifications[1].type, HE_NOTIFY_SENT);
    assert.match(notifications[1].title, /HE pre-approved/);
    assert.match(notifications[1].body, /pre-approval/i);
    assert.equal(sentBodies.length, 1);
    assert.match(sentBodies[0], /pre-approval/i);
    assert.match(sentBodies[0], /blocked those dates for you/i);
    assert.equal(/you.?re booked/i.test(sentBodies[0]), false);
    assert.equal(/welcome to book/i.test(sentBodies[0]), false);
    assert.match(result.proposedResponse, /May 13–19, 2027/);
    assert.equal(shouldAttemptPreapprove({
      isFirst: false,
      feeAccepted: true,
      originalCheckIn: '2027-05-13',
      originalCheckOut: '2027-05-19',
      originalCalendar: result.originalCalendar,
    }), true);
  });

  it('Katie Apt #2: “completely fine with the cleaning fee” pre-approves (not you’re welcome)', async () => {
    // Exact 2026-08-17 guest text (curly apostrophe) that was wrongly answered
    // with "You're welcome, Katie!" instead of HE pre-approve + invite.
    const katieFeeOk =
      'Hi Ruby, oh that is great news. We\u2019re completely fine with the cleaning fee!';
    assert.equal(guestAcceptedCleaningFee(katieFeeOk), true);
    assert.equal(guestAcceptedCleaningFee(katieFeeOk.replace('\u2019', "'")), true);
    assert.equal(thisTurnWantsHePreapprove(katieFeeOk), true);
    assert.equal(isHeSharedThankYouMessage(katieFeeOk), false);
    assert.equal(
      shouldRunSharedHeCategories({
        isFirst: false,
        heDraftSendable: false,
        preapproveOk: false,
        thisTurnWantsPreapprove: true,
      }),
      false
    );

    const approved = [];
    const blocked = [];
    const sentBodies = [];
    const notifications = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: katieFeeOk,
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95201321',
          guestName: 'Katie',
          checkIn: '2026-10-29',
          checkOut: '2026-11-02',
          listing: { platform: 'homeexchange', platform_id: '3285044' },
        },
      },
      hospitableClient: {
        async getPropertyCalendar(propertyId) {
          assert.equal(propertyId, '114663c5-0709-4eff-a868-fa9ebd6ed42d');
          return ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'].map((date) => ({
            date,
            status: { available: true },
          }));
        },
        async getPropertyReservations() {
          return [];
        },
        async updatePropertyCalendar(_id, dates) {
          blocked.push(...dates);
          return { status: 'accepted' };
        },
      },
      ddbClient: {
        async send() {
          return { Item: { listingId: 20150380, name: 'Pine Apt #2', price: 120 } };
        },
      },
      homeExchangeClient: {
        async getHomeCalendar(homeId) {
          assert.equal(String(homeId), '3285044');
          return heOpenRange('2026-10-25', '2026-11-05');
        },
        async getConversation() {
          return {
            exchanges: [
              {
                id: 127348833,
                status: 0,
                approved_at: null,
                start_on: '2026-10-29',
                end_on: '2026-11-02',
                home: { id: 3285044 },
              },
            ],
          };
        },
        async approveConversation(conversationId) {
          approved.push(conversationId);
          return { ok: true };
        },
        async sendMessage(_id, content) {
          sentBodies.push(content);
          return { ok: true };
        },
      },
      blockStore: {
        async put(item) {
          return item;
        },
      },
      notifyOwner: async (payload) => {
        notifications.push(payload);
        return { ok: true };
      },
      sharedCategoryRunner: async () => {
        throw new Error('must not fall through to shared thank-you');
      },
    });
    assert.equal(result.feeAccepted, true);
    assert.equal(result.homeId, '3285044');
    assert.equal(result.propertyId, '114663c5-0709-4eff-a868-fa9ebd6ed42d');
    assert.equal(result.calendar.open, true);
    assert.equal(result.preapprove.ok, true);
    assert.deepEqual(approved, ['95201321']);
    assert.equal(blocked.length, 4);
    assert.equal(blocked[0].date, '2026-10-29');
    assert.equal(blocked[3].date, '2026-11-01');
    assert.equal(result.sent, true);
    assert.equal(sentBodies.length, 1);
    assert.match(sentBodies[0], /pre-approval/i);
    assert.match(sentBodies[0], /blocked those dates for you/i);
    assert.match(sentBodies[0], /\$120/);
    assert.equal(/you.?re welcome/i.test(sentBodies[0]), false);
    assert.equal(result.typeOfMessageReceived, 'HOMEEXCHANGE_FOLLOWUP');
    assert.equal(result.reason, 'homeexchange_preapproved');
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0].type, HE_NOTIFY_READY);
    assert.match(notifications[0].title, /Katie/);
    assert.match(notifications[0].body, /Pine Apt #2/);
    assert.match(notifications[0].body, /invited to book/i);
    assert.equal(notifications[0].data.listingId, '20150380');
    assert.equal(notifications[0].data.conversationId, '95201321');
    assert.equal(notifications[1].type, HE_NOTIFY_SENT);
    assert.match(notifications[1].title, /HE pre-approved/);
    assert.match(notifications[1].body, /Pine Apt #2/);
  });

  it('treats a later “pre approve then we finalize” as fee-accepted via thread history', async () => {
    assert.equal(guestAskedToPreapprove('Wonderful. I guess u pre approve then we finalize?'), true);
    assert.equal(guestAcceptedCleaningFee('Wonderful. I guess u pre approve then we finalize?'), false);
    assert.equal(
      guestAcceptedCleaningFeeInThread('Wonderful. I guess u pre approve then we finalize?', [
        { sender_type: 'guest', content: 'Hi Ruby, the cleaning fee is fine. Sep dates?' },
      ]),
      true
    );
    const sentBodies = [];
    const approved = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'Wonderful. I guess u pre approve then we finalize?',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
          checkIn: '2027-05-13',
          checkOut: '2027-05-19',
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return ['2027-05-13', '2027-05-14', '2027-05-15', '2027-05-16', '2027-05-17', '2027-05-18']
            .map((date) => ({ date, status: { available: true } }));
        },
        async getPropertyReservations() {
          return [];
        },
        async updatePropertyCalendar() {
          return { status: 'accepted' };
        },
      },
      ddbClient: { async send() { return { Item: { price: 125 } }; } },
      homeExchangeClient: {
        async listMessages() {
          return [
            { content: 'Hi Ruby, the cleaning fee is fine. Just out of curiosity…', author: { first_name: 'Caroline' }, sender_type: 'guest' },
          ];
        },
        async getHomeCalendar() {
          return heOpenRange('2027-01-04', '2027-06-01');
        },
        async getConversation() {
          return { exchanges: [{ id: 127232869, status: 0, approved_at: null, home: { id: 3202475 } }] };
        },
        async approveExchange(id) {
          approved.push(id);
          return { ok: true };
        },
        async sendMessage(_id, content) {
          sentBodies.push(content);
          return { ok: true };
        },
      },
      blockStore: { async put(item) { return item; } },
      notifyOwner: async () => ({ ok: true }),
    });
    assert.equal(result.feeAccepted, true);
    assert.equal(result.preapprove.ok, true);
    assert.deepEqual(approved, [127232869]);
    assert.equal(result.sent, true);
    assert.match(sentBodies[0], /blocked those dates for you/i);
  });

  it('notifies Android and does not proceed when HE is already pre-approved', async () => {
    const notifications = [];
    let approveCalls = 0;
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'the cleaning fee is fine',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
          checkIn: '2027-05-13',
          checkOut: '2027-05-19',
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return ['2027-05-13', '2027-05-14', '2027-05-15', '2027-05-16', '2027-05-17', '2027-05-18']
            .map((date) => ({ date, status: { available: true } }));
        },
        async getPropertyReservations() {
          return [];
        },
        async updatePropertyCalendar() {
          throw new Error('must not block');
        },
      },
      ddbClient: { async send() { return { Item: { price: 125 } }; } },
      homeExchangeClient: {
        async getHomeCalendar() {
          return heOpenRange('2027-01-04', '2027-06-01');
        },
        async getConversation() {
          return {
            accepted: 1,
            exchanges: [
              { id: 9, finalized_at: '2026-08-14T00:00:00Z', home: { id: 3202475 } },
            ],
          };
        },
        async approveExchange() {
          approveCalls += 1;
        },
      },
      notifyOwner: async (payload) => {
        notifications.push(payload);
        return { ok: true };
      },
    });
    assert.equal(result.preapprove.reason, 'already_approved');
    assert.equal(result.preapprove.ok, false);
    assert.equal(approveCalls, 0);
    assert.equal(notifications[0].type, 'homeexchange_preapproval_error');
    assert.equal(exchangeAlreadyApproved({ approved_at: 'x' }), true);
    assert.equal(exchangeAlreadyApproved({ status: 1, approved_at: null }), true);
  });

  it('notifies Android and does not send when Hospitable block fails after approve', async () => {
    const notifications = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'the cleaning fee is fine',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
          checkIn: '2027-05-13',
          checkOut: '2027-05-19',
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return ['2027-05-13', '2027-05-14', '2027-05-15', '2027-05-16', '2027-05-17', '2027-05-18']
            .map((date) => ({ date, status: { available: true } }));
        },
        async getPropertyReservations() {
          return [];
        },
        async updatePropertyCalendar() {
          throw new Error('calendar write denied');
        },
      },
      ddbClient: { async send() { return { Item: { price: 125 } }; } },
      homeExchangeClient: {
        async getHomeCalendar() {
          return heOpenRange('2027-01-04', '2027-06-01');
        },
        async getConversation() {
          return { exchanges: [{ id: 11, approved_at: null, home: { id: 3202475 } }] };
        },
        async approveExchange() {
          return { ok: true };
        },
        async sendMessage() {
          throw new Error('must not send');
        },
      },
      notifyOwner: async (payload) => {
        notifications.push(payload);
        return { ok: true };
      },
    });
    assert.equal(result.sent, false);
    assert.equal(result.preapprove.reason, 'block_failed');
    assert.match(notifications[0].body, /Hospitable block failed/i);
    assert.equal(notifications.some((n) => n.type === HE_NOTIFY_SENT), false);
  });

  it('notifies Android when an HE auto-reply send fails after retries', async () => {
    const notifications = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'Hi we would like May 13-19',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: true,
          conversation_id: '95101669',
          guestName: 'Caroline',
          checkIn: '2027-05-13',
          checkOut: '2027-05-19',
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return ['2027-05-13', '2027-05-14', '2027-05-15', '2027-05-16', '2027-05-17', '2027-05-18']
            .map((date) => ({ date, status: { available: true } }));
        },
        async getPropertyReservations() {
          return [];
        },
      },
      ddbClient: { async send() { return { Item: { price: 125 } }; } },
      homeExchangeClient: {
        async getHomeCalendar() {
          return heOpenRange('2027-01-04', '2027-06-01');
        },
        async sendMessage() {
          throw new Error('HE send 503 after retries');
        },
      },
      notifyOwner: async (payload) => {
        notifications.push(payload);
        return { ok: true };
      },
    });
    assert.equal(result.sent, false);
    assert.match(result.sendError, /HE send 503/);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, HE_NOTIFY_SEND_FAILED);
    assert.match(notifications[0].body, /not sent/i);
  });

  it('does not notify Android when HE auto-reply is skipped (no send)', async () => {
    const notifications = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'Just thinking about our trip.',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
        },
      },
      notifyOwner: async (payload) => {
        notifications.push(payload);
        return { ok: true };
      },
    });
    assert.equal(result.sent, false);
    assert.equal(notifications.length, 0);
  });

  it('notifies Android when a shared HE thank-you is sent', async () => {
    const notifications = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'Thanks!',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
        },
      },
      homeExchangeClient: {
        async sendMessage() {
          return { ok: true };
        },
      },
      notifyOwner: async (payload) => {
        notifications.push(payload);
        return { ok: true };
      },
    });
    assert.equal(result.sent, true);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, HE_NOTIFY_SENT);
    assert.match(notifications[0].body, /You.?re welcome/i);
  });

  it('shares checkout time with HE via deterministic category', async () => {
    const sentBodies = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'What is the latest checkout time?',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
        },
      },
      homeExchangeClient: {
        async sendMessage(_id, content) {
          sentBodies.push(content);
        },
      },
    });
    assert.equal(result.sent, true);
    assert.match(sentBodies[0], /Checkout is strictly at 10am/i);
    assert.equal(result.reason, 'homeexchange_shared_checkout_time');
  });

  it('uses injected shared agent for other HE categories and never Airbnb-only ones', async () => {
    const sentBodies = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: 'Where can we park?',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
        },
      },
      homeExchangeClient: {
        async sendMessage(_id, content) {
          sentBodies.push(content);
        },
      },
      sharedCategoryRunner: async () => ({
        typeOfMessageReceived: 'PARKING',
        shouldReply: true,
        proposedResponse: 'You will have one dedicated off-street parking spot at the property.',
        reason: 'homeexchange_shared_agent',
        sharedCategory: true,
      }),
    });
    assert.equal(result.sent, true);
    assert.equal(result.typeOfMessageReceived, 'PARKING');
    assert.match(sentBodies[0], /parking spot/i);

    const blocked = await handleHomeExchangeMessage({
      event: {
        message: 'Can I update my payment method?',
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95101669',
          guestName: 'Caroline',
        },
      },
      homeExchangeClient: {
        async sendMessage() {
          throw new Error('must not send airbnb-only');
        },
      },
      sharedCategoryRunner: async () => ({
        typeOfMessageReceived: 'PAYMENT_METHOD_UPDATE',
        shouldReply: true,
        proposedResponse: 'Please reach out to Airbnb.',
        reason: 'homeexchange_airbnb_only_category',
        sharedCategory: true,
      }),
    });
    assert.equal(blocked.sent, false);
    assert.equal(isAirbnbOnlyHeCategory('PAYMENT_METHOD_UPDATE'), true);
    assert.equal(isAirbnbOnlyHeCategory('THANK_YOU_MESSAGE'), false);
  });

  it('detects HE shared thank-you / times and does not treat thanks as a pre-approve turn', () => {
    assert.equal(isHeSharedThankYouMessage('Thank you. Coming your way!'), true);
    assert.equal(isHeSharedThankYouMessage('Thanks!'), true);
    assert.equal(isHeSharedThankYouMessage('What time is checkout?'), false);
    assert.equal(isHeCheckoutTimeQuestion('What is the latest checkout time?'), true);
    assert.equal(isHeCheckinTimeQuestion('What time is check-in?'), true);
    assert.equal(thisTurnWantsHePreapprove('Thank you. Coming your way!'), false);
    assert.equal(thisTurnWantsHePreapprove('the cleaning fee is fine'), true);
    assert.equal(
      thisTurnWantsHePreapprove(
        'Hi Ruby, oh that is great news. We\u2019re completely fine with the cleaning fee!'
      ),
      true
    );
    assert.equal(thisTurnWantsHePreapprove('Wonderful. I guess u pre approve then we finalize?'), true);
    assert.equal(
      shouldAttemptPreapprove({
        isFirst: false,
        feeAccepted: true,
        originalCheckIn: '2027-05-13',
        originalCheckOut: '2027-05-19',
        originalCalendar: { checked: true, open: true },
        thisTurnWantsPreapprove: false,
      }),
      false
    );
    const thanks = buildDeterministicHeSharedDraft({
      message: 'Thank you. Coming your way!',
      guestName: 'Caroline',
    });
    assert.equal(thanks.proposedResponse, "You're welcome, Caroline!");
    assert.equal(shouldRunSharedHeCategories({ isFirst: true, heDraftSendable: false }), false);
    assert.equal(shouldRunSharedHeCategories({ isFirst: false, heDraftSendable: false, preapproveOk: false }), true);
  });

  it('builds HE owner FCM payloads for sent / failed auto-replies', () => {
    const sent = buildHeAutoReplyNotify({
      kind: 'sent',
      guestName: 'Caroline',
      checkIn: '2027-05-13',
      checkOut: '2027-05-19',
      conversationId: '95101669',
      proposedResponse: 'I just sent you a pre-approval and blocked those dates for you.',
      reason: 'homeexchange_preapproved',
      preapproved: true,
    });
    assert.equal(sent.type, HE_NOTIFY_SENT);
    assert.match(sent.title, /Caroline/);
    assert.match(sent.body, /Pre-approval note sent/);
    assert.equal(sent.data.peerName, 'Caroline');
    const failed = buildHeAutoReplyNotify({
      kind: 'send_failed',
      guestName: 'Caroline',
      checkIn: '2027-05-13',
      checkOut: '2027-05-19',
      conversationId: '95101669',
      error: 'timeout',
    });
    assert.equal(failed.type, HE_NOTIFY_SEND_FAILED);
    const ready = buildHePreapprovalNotify({
      kind: 'ready',
      guestName: 'Katie',
      checkIn: '2026-10-29',
      checkOut: '2026-11-02',
      conversationId: '95201321',
      propertyName: 'Pine Apt #2',
      listingId: '20150380',
      homeId: '3285044',
    });
    assert.equal(ready.type, HE_NOTIFY_READY);
    assert.match(ready.title, /Katie/);
    assert.match(ready.body, /Pine Apt #2/);
    assert.match(ready.body, /invited to book/i);
    assert.equal(/Pine #3/.test(ready.body), false);
    assert.equal(ready.data.listingId, '20150380');
    assert.equal(ready.data.conversationId, '95201321');
    assert.equal(/NOT sent/i.test(ready.body), false);
  });

  it('unblocks only Hospitable BLOCKED nights after HE pre-approval expires', () => {
    const now = new Date('2026-08-20T00:00:00Z');
    const expired = shouldUnblockPreapproval(
      {
        status: 'pending_finalization',
        expiresAt: '2026-08-19T00:00:00.000Z',
      },
      { approved_at: '2026-08-15T00:00:00Z', finalized_at: null, status: 0 },
      now
    );
    assert.equal(expired.unblock, true);
    assert.equal(expired.reason, 'expired');

    const finalized = shouldUnblockPreapproval(
      { status: 'pending_finalization', expiresAt: '2026-08-19T00:00:00.000Z' },
      { finalized_at: '2026-08-16T00:00:00Z' },
      now
    );
    assert.equal(finalized.unblock, false);
    assert.equal(finalized.markFinalized, true);

    assert.equal(
      canUnblockCalendarDay({ status: { available: false, reason: 'BLOCKED', source_type: 'USER' } }),
      true
    );
    assert.equal(
      canUnblockCalendarDay({ status: { available: false, reason: 'RESERVED', source_type: 'RESERVATION' } }),
      false
    );
  });
});

describe('HomeExchange extra night after cancelled pre-approval (Katie)', () => {
  const katieExtraNight =
    'Hi Ruby, would you mind if we actually added one more night and checked out on November 3?';
  const katieSubmitted = 'Just submitted, thank you!';
  const priorPreapproval =
    'Hi Katie — thanks for confirming the $120 cleaning fee is fine for October 29 – November 2, 2026. I just sent you a pre-approval for October 29 – November 2, 2026 and blocked those dates for you.';
  const katieHistory = [
    {
      sender_type: 'guest',
      author: { first_name: 'Katie' },
      content: 'Hi Ruby, oh that is great news. We’re completely fine with the cleaning fee!',
    },
    { sender_type: 'host', content: priorPreapproval },
    { sender_type: 'guest', author: { first_name: 'Katie' }, content: katieExtraNight },
    { content: '((firstName)) has cancelled the pre-approval' },
    { content: '((firstName)) has modified the end date' },
    { sender_type: 'guest', author: { first_name: 'Katie' }, content: katieSubmitted },
  ];

  it('parses checkout-on extra night and leftover blocks', () => {
    const asked = extractAskedStayDates(katieExtraNight, {
      now: new Date('2026-08-17T12:00:00Z'),
      originalCheckIn: '2026-10-29',
      originalCheckOut: '2026-11-02',
    });
    assert.equal(asked.checkIn, '2026-10-29');
    assert.equal(asked.checkOut, '2026-11-03');
    assert.equal(guestAskedToAddNights(katieExtraNight), true);
    assert.equal(isStayExtensionOf('2026-10-29', '2026-11-02', '2026-10-29', '2026-11-03'), true);
    assert.deepEqual(extraNightsOf('2026-10-29', '2026-11-02', '2026-10-29', '2026-11-03'), [
      '2026-11-02',
    ]);
    assert.deepEqual(
      extractFormattedStayRange(priorPreapproval),
      { checkIn: '2026-10-29', checkOut: '2026-11-02', yearSource: 'explicit' }
    );
    assert.deepEqual(extractPriorPreapprovalStay(katieHistory), {
      checkIn: '2026-10-29',
      checkOut: '2026-11-02',
      yearSource: 'explicit',
    });

    const leftover = analyzeCalendarOpen({
      calendarDays: [
        { date: '2026-10-29', status: { available: false } },
        { date: '2026-10-30', status: { available: false } },
        { date: '2026-10-31', status: { available: false } },
        { date: '2026-11-01', status: { available: false } },
        { date: '2026-11-02', status: { available: true } },
      ],
      reservations: [],
      checkIn: '2026-10-29',
      checkOut: '2026-11-03',
      leftoverNights: ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
    });
    assert.equal(leftover.open, true);
    assert.deepEqual(leftover.unavailable, []);
    assert.ok(leftover.available.includes('2026-11-02'));

    const extraBlocked = analyzeCalendarOpen({
      calendarDays: [
        { date: '2026-10-29', status: { available: false } },
        { date: '2026-10-30', status: { available: false } },
        { date: '2026-10-31', status: { available: false } },
        { date: '2026-11-01', status: { available: false } },
        { date: '2026-11-02', status: { available: false } },
      ],
      reservations: [
        {
          check_in: '2026-11-02',
          check_out: '2026-11-03',
          reservation_status: { current: { category: 'accepted' } },
        },
      ],
      checkIn: '2026-10-29',
      checkOut: '2026-11-03',
      leftoverNights: ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
    });
    assert.equal(extraBlocked.open, false);
    assert.deepEqual(extraBlocked.unavailable, ['2026-11-02']);
  });

  it('treats Just submitted after cancel as a re-approve turn, not you’re welcome', () => {
    assert.equal(threadHasCancelledPreapproval(katieHistory), true);
    assert.equal(guestResubmittedAfterHeCancel(katieSubmitted, katieHistory), true);
    assert.equal(thisTurnWantsHePreapprove(katieSubmitted, { conversationHistory: katieHistory }), true);
    assert.equal(thisTurnWantsHePreapprove('Thank you. Coming your way!'), false);
    assert.equal(isHeSharedThankYouMessage(katieSubmitted), true);
    assert.equal(
      shouldRunSharedHeCategories({
        isFirst: false,
        heDraftSendable: false,
        preapproveOk: false,
        thisTurnWantsPreapprove: true,
      }),
      false
    );
  });

  it('Katie cancel + extra night: leftover Hospitable blocks, extra night free, re-approves Nov 3', async () => {
    const approved = [];
    const blocked = [];
    const sentBodies = [];
    const notifications = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: katieSubmitted,
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95201321',
          guestName: 'Katie',
          checkIn: '2026-10-29',
          checkOut: '2026-11-03',
          listing: { platform: 'homeexchange', platform_id: '3285044' },
          conversationHistory: katieHistory,
        },
      },
      hospitableClient: {
        async getPropertyCalendar(propertyId) {
          assert.equal(propertyId, '114663c5-0709-4eff-a868-fa9ebd6ed42d');
          return [
            { date: '2026-10-29', status: { available: false } },
            { date: '2026-10-30', status: { available: false } },
            { date: '2026-10-31', status: { available: false } },
            { date: '2026-11-01', status: { available: false } },
            { date: '2026-11-02', status: { available: true } },
          ];
        },
        async getPropertyReservations() {
          return [];
        },
        async updatePropertyCalendar(_id, dates) {
          blocked.push(...dates);
          return { status: 'accepted' };
        },
      },
      ddbClient: {
        async send() {
          return { Item: { listingId: 20150380, name: 'Pine Apt #2', price: 120 } };
        },
      },
      homeExchangeClient: {
        async listMessages() {
          return katieHistory;
        },
        async getHomeCalendar(homeId) {
          assert.equal(String(homeId), '3285044');
          return heOpenRange('2026-10-25', '2026-11-05');
        },
        async getConversation() {
          return {
            exchanges: [
              {
                id: 127348833,
                status: 0,
                approved_at: null,
                start_on: '2026-10-29',
                end_on: '2026-11-03',
                home: { id: 3285044 },
              },
            ],
          };
        },
        async approveConversation(conversationId) {
          approved.push(conversationId);
          return { ok: true };
        },
        async sendMessage(_id, content) {
          sentBodies.push(content);
          return { ok: true };
        },
      },
      blockStore: { async put(item) { return item; } },
      notifyOwner: async (payload) => {
        notifications.push(payload);
        return { ok: true };
      },
      sharedCategoryRunner: async () => {
        throw new Error('must not fall through to shared thank-you');
      },
    });
    assert.equal(result.feeAccepted, true);
    assert.equal(result.cancelledPreapproval, true);
    assert.equal(result.isExtension, true);
    assert.deepEqual(result.extraNights, ['2026-11-02']);
    assert.equal(result.extraNightsOpen, true);
    assert.equal(result.calendar.open, true);
    assert.equal(result.preapprove.ok, true);
    assert.deepEqual(approved, ['95201321']);
    assert.equal(blocked.length, 5);
    assert.equal(blocked[0].date, '2026-10-29');
    assert.equal(blocked[4].date, '2026-11-02');
    assert.equal(result.sent, true);
    assert.equal(sentBodies.length, 1);
    assert.match(sentBodies[0], /pre-approval/i);
    assert.match(sentBodies[0], /blocked those dates for you/i);
    assert.match(sentBodies[0], /November 3, 2026/);
    assert.match(sentBodies[0], /extra night/i);
    assert.match(sentBodies[0], /November 2, 2026/);
    assert.match(sentBodies[0], /is open/i);
    assert.equal(/you.?re welcome/i.test(sentBodies[0]), false);
    assert.equal(/alteration/i.test(sentBodies[0]), false);
    assert.equal(result.reason, 'homeexchange_preapproved');
    assert.equal(
      alreadySentEquivalent([{ content: priorPreapproval }], sentBodies[0]),
      false
    );
    assert.equal(notifications[0].type, HE_NOTIFY_READY);
  });

  it('does not re-approve when the extra night is taken by another reservation', async () => {
    const approved = [];
    const sentBodies = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: katieSubmitted,
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95201321',
          guestName: 'Katie',
          checkIn: '2026-10-29',
          checkOut: '2026-11-03',
          listing: { platform: 'homeexchange', platform_id: '3285044' },
          conversationHistory: katieHistory,
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return [
            { date: '2026-10-29', status: { available: false } },
            { date: '2026-10-30', status: { available: false } },
            { date: '2026-10-31', status: { available: false } },
            { date: '2026-11-01', status: { available: false } },
            { date: '2026-11-02', status: { available: false } },
          ];
        },
        async getPropertyReservations() {
          return [
            {
              check_in: '2026-11-02',
              check_out: '2026-11-03',
              reservation_status: { current: { category: 'accepted' } },
            },
          ];
        },
        async updatePropertyCalendar() {
          throw new Error('must not block');
        },
      },
      ddbClient: { async send() { return { Item: { price: 120 } }; } },
      homeExchangeClient: {
        async listMessages() {
          return katieHistory;
        },
        async getHomeCalendar() {
          return heOpenRange('2026-10-25', '2026-11-05');
        },
        async getConversation() {
          return {
            exchanges: [
              {
                id: 127348833,
                status: 0,
                approved_at: null,
                start_on: '2026-10-29',
                end_on: '2026-11-03',
                home: { id: 3285044 },
              },
            ],
          };
        },
        async approveConversation() {
          approved.push('nope');
          return { ok: true };
        },
        async sendMessage(_id, content) {
          sentBodies.push(content);
          return { ok: true };
        },
      },
      blockStore: { async put() { return {}; } },
      notifyOwner: async () => ({ ok: true }),
    });
    assert.equal(result.preapprove.ok, false);
    assert.deepEqual(approved, []);
    assert.equal(result.sent, true);
    assert.match(sentBodies[0], /not open/i);
    assert.match(sentBodies[0], /extra night/i);
    assert.equal(/blocked those dates/i.test(sentBodies[0]), false);
    assert.equal(/I just sent you a pre-approval/i.test(sentBodies[0]), false);
    assert.equal(/you.?re welcome/i.test(sentBodies[0]), false);
  });

  it('extra-night ask while still pre-approved does not ask for an Airbnb alteration', async () => {
    const approved = [];
    const sentBodies = [];
    const result = await handleHomeExchangeMessage({
      event: {
        message: katieExtraNight,
        context: {
          platform: HOMEEXCHANGE_PLATFORM,
          isFirstMessage: false,
          conversation_id: '95201321',
          guestName: 'Katie',
          checkIn: '2026-10-29',
          checkOut: '2026-11-02',
          listing: { platform: 'homeexchange', platform_id: '3285044' },
          conversationHistory: [
            {
              sender_type: 'guest',
              content: 'We’re completely fine with the cleaning fee!',
            },
            { sender_type: 'host', content: priorPreapproval },
          ],
        },
      },
      hospitableClient: {
        async getPropertyCalendar() {
          return [
            { date: '2026-10-29', status: { available: false } },
            { date: '2026-10-30', status: { available: false } },
            { date: '2026-10-31', status: { available: false } },
            { date: '2026-11-01', status: { available: false } },
            { date: '2026-11-02', status: { available: true } },
          ];
        },
        async getPropertyReservations() {
          return [];
        },
        async updatePropertyCalendar() {
          throw new Error('must not reblock while still approved');
        },
      },
      ddbClient: { async send() { return { Item: { price: 120 } }; } },
      homeExchangeClient: {
        async listMessages() {
          return [{ content: priorPreapproval }];
        },
        async getHomeCalendar() {
          return heOpenRange('2026-10-25', '2026-11-05');
        },
        async getConversation() {
          return {
            exchanges: [
              {
                id: 127348833,
                status: 1,
                approved_at: '2026-08-17T16:57:00+0000',
                start_on: '2026-10-29',
                end_on: '2026-11-02',
                home: { id: 3285044 },
              },
            ],
          };
        },
        async approveConversation() {
          approved.push('nope');
          return { ok: true };
        },
        async sendMessage(_id, content) {
          sentBodies.push(content);
          return { ok: true };
        },
      },
      blockStore: { async put() { return {}; } },
      notifyOwner: async () => ({ ok: true }),
    });
    assert.equal(result.preapprove.ok, false);
    assert.deepEqual(approved, []);
    assert.equal(result.sent, true);
    assert.match(sentBodies[0], /extra night/i);
    assert.match(sentBodies[0], /is open/i);
    assert.match(sentBodies[0], /HomeExchange/i);
    assert.equal(/alteration/i.test(sentBodies[0]), false);
    assert.equal(/you.?re welcome/i.test(sentBodies[0]), false);
  });
});
