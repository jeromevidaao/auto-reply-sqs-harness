import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isHomeExchangePayload,
  extractHomeExchangeMessage,
  isFirstHomeExchangeMessage,
  stayNights,
  analyzeCalendarOpen,
  buildHomeExchangeDraft,
  handleHomeExchangeMessage,
  shouldSendHomeExchangeDraft,
  shouldAttemptPreapprove,
  extractAskedStayDates,
  guestAcceptedCleaningFee,
  analyzeHeCalendarOpen,
  mergeStayCalendars,
  HOMEEXCHANGE_ACT,
  HOMEEXCHANGE_PLATFORM,
  APT3_AIRBNB_LISTING_ID,
} from '../src/useCases/homeExchange.js';
import { alreadySentEquivalent } from '../src/clients/HomeExchangeClient.js';
import { shouldUnblockPreapproval, canUnblockCalendarDay } from '../src/useCases/homeExchangeExpire.js';
import { exchangeAlreadyApproved } from '../src/clients/homeExchangeExchange.js';

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
      checkIn: '2027-05-13',
      checkOut: '2027-05-19',
      calendar: blocked,
      cleaningFee: { amount: 125 },
      isFirst: true,
    });
    assert.match(draft.proposedResponse, /not open/i);
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

  it('does not send a follow-up even when an HE client is present', async () => {
    let sent = 0;
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
    assert.equal(notifications[0].type, 'homeexchange_preapproval_ready');
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
            exchanges: [
              { id: 9, approved_at: '2026-08-14T00:00:00Z', home: { id: 3202475 } },
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
