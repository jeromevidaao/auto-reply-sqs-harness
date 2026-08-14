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
  HOMEEXCHANGE_ACT,
  HOMEEXCHANGE_PLATFORM,
  APT3_AIRBNB_LISTING_ID,
} from '../src/useCases/homeExchange.js';
import { alreadySentEquivalent } from '../src/clients/HomeExchangeClient.js';

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

  it('does not draft a sendable follow-up (send stays disabled)', () => {
    const draft = buildHomeExchangeDraft({
      guestName: 'Caroline',
      isFirst: false,
    });
    assert.equal(draft.typeOfMessageReceived, 'HOMEEXCHANGE_FOLLOWUP');
    assert.equal(draft.shouldReply, false);
    assert.equal(draft.proposedResponse, null);
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
