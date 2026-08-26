import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { UnitReadinessTool } from '../src/tools/unit-readiness/UnitReadinessTool.js';
import { ymdInAmericaNewYork, previousYmd } from '../src/utils/guestCheckIns.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

const APT3_UUID = '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd';
const APT3_AIRBNB = '24259977';
const TREVOR_MSG =
  "Ok we’ll come back closer to 4 if it’s not ready, figured we’d ask ;-)";

function agentForTests() {
  return new GuestMessagingAgent({
    projectRoot: projectRootForTests,
    llmAdapter: { complete: async () => '{}' },
  });
}

describe('UnitReadinessTool (DynamoDB cleaning table)', () => {
  it('uses listingIdAndDate + Airbnb listing id for today, not pk / Hospitable UUID', async () => {
    const keys = [];
    const tool = new UnitReadinessTool({
      ddbClient: {
        send: async (cmd) => {
          keys.push(cmd.input);
          return {};
        },
      },
      hospitableClient: { async hasGuestsOnDate() { return true; } },
    });
    const out = await tool.execute(
      {},
      {
        listingId: APT3_UUID,
        checkIn: '2026-08-26T16:00:00-04:00',
        asOfDate: '2026-08-26',
      }
    );
    assert.equal(keys[0].TableName, 'cleaning');
    assert.equal(keys[0].Key.listingIdAndDate, `${APT3_AIRBNB}_2026-08-26`);
    assert.equal(keys[0].Key.pk, undefined);
    assert.equal(out.isUnitReady, false);
    assert.equal(out.buttonPressed, false);
    assert.equal(out.hadPreviousDayGuests, true);
    assert.equal(out.airbnbListingId, APT3_AIRBNB);
  });

  it('treats pressedAt as cleaned / ready after a previous-night guest', async () => {
    const tool = new UnitReadinessTool({
      ddbClient: {
        send: async () => ({
          Item: {
            listingIdAndDate: `${APT3_AIRBNB}_2026-08-26`,
            pressedAt: '2026-08-26T16:20:34.921Z',
          },
        }),
      },
      hospitableClient: { async hasGuestsOnDate() { return true; } },
    });
    const out = await tool.execute(
      {},
      {
        listingId: APT3_UUID,
        checkIn: '2026-08-26T16:00:00-04:00',
        asOfDate: '2026-08-26',
      }
    );
    assert.equal(out.isUnitReady, true);
    assert.equal(out.buttonPressed, true);
    assert.equal(out.pressedAt, '2026-08-26T16:20:34.921Z');
  });

  it('vacant previous night is ready even without a press row', async () => {
    const tool = new UnitReadinessTool({
      ddbClient: { send: async () => ({}) },
      hospitableClient: { async hasGuestsOnDate() { return false; } },
    });
    const out = await tool.execute(
      {},
      {
        listingId: APT3_UUID,
        checkIn: '2026-08-26T16:00:00-04:00',
        asOfDate: '2026-08-26',
      }
    );
    assert.equal(out.isUnitReady, true);
    assert.equal(out.hadPreviousDayGuests, false);
  });
});

describe('check-in-day not-ready policy (Trevor)', () => {
  it('treats ISO checkIn as check-in day vs America/New_York today', () => {
    const agent = agentForTests();
    assert.equal(
      agent._looksLikeCheckInDay({
        checkIn: '2026-08-26T16:00:00-04:00',
        asOfDate: '2026-08-26',
      }),
      true
    );
    assert.equal(
      agent._looksLikeCheckInDay({
        checkIn: '2026-08-26T16:00:00-04:00',
        asOfDate: '2026-08-25',
      }),
      false
    );
  });

  it('matches Trevor FYI without a question mark', () => {
    const agent = agentForTests();
    assert.equal(agent._isCheckInDayReadinessAsk(TREVOR_MSG), true);
    assert.equal(
      agent._isCheckInDayReadinessAsk('We’re about 5 min away, should we kill an hour? Thanks again!'),
      true
    );
    assert.equal(agent._isCheckInDayReadinessAsk('Thank you so much!'), false);
  });

  it('forces sorry-not-ready when cleaning table has no pressedAt', () => {
    const agent = agentForTests();
    const ctx = {
      guestName: 'Trevor',
      checkIn: '2026-08-26T16:00:00-04:00',
      asOfDate: '2026-08-26',
      listingId: APT3_UUID,
      unitReadiness: {
        isUnitReady: false,
        buttonPressed: false,
        hadPreviousDayGuests: true,
      },
      conversationTraces: { earlyUnitReadyOffered: false },
    };
    const parsed = {
      typeOfMessageReceived: 'FYI_STATEMENT',
      proposedResponse: "You're welcome, Trevor!",
      shouldReply: false,
      confidence: 0.95,
    };
    const applied = agent._applyCheckInDayNotReadyPolicy(parsed, ctx, TREVOR_MSG);
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.typeOfMessageReceived, 'EARLY_CHECKIN');
    assert.match(applied.proposedResponse, /sorry/i);
    assert.match(applied.proposedResponse, /not ready yet/i);
    assert.match(applied.proposedResponse, /4pm/i);
    assert.match(applied.proposedResponse, /message you/i);
    assert.doesNotMatch(applied.proposedResponse, /cleaning button/i);
    assert.doesNotMatch(applied.proposedResponse, /you're welcome/i);
  });

  it('does not force not-ready when host already said the unit is ready', () => {
    const agent = agentForTests();
    const applied = agent._applyCheckInDayNotReadyPolicy(
      { typeOfMessageReceived: 'THANK_YOU_MESSAGE', proposedResponse: "You're welcome!" },
      {
        guestName: 'Taylor',
        checkIn: '2026-08-26T16:00:00-04:00',
        asOfDate: '2026-08-26',
        unitReadiness: { isUnitReady: false, buttonPressed: false, hadPreviousDayGuests: true },
        conversationTraces: { earlyUnitReadyOffered: true },
      },
      TREVOR_MSG
    );
    assert.equal(applied.applied, false);
  });

  it('does not apply the day before check-in (Olivia)', () => {
    const agent = agentForTests();
    const applied = agent._applyCheckInDayNotReadyPolicy(
      { typeOfMessageReceived: 'EARLY_CHECKIN', proposedResponse: 'Check-in is at 4pm.' },
      {
        guestName: 'Olivia',
        checkIn: '2026-07-31T16:00:00-04:00',
        asOfDate: '2026-07-30',
        unitReadiness: { isUnitReady: false, buttonPressed: false, hadPreviousDayGuests: true },
      },
      'Is there any opportunity for an early check in?'
    );
    assert.equal(applied.applied, false);
  });

  it('ymd helpers stay on the calendar date', () => {
    assert.equal(previousYmd('2026-08-26'), '2026-08-25');
    assert.equal(ymdInAmericaNewYork('2026-08-26T16:00:00-04:00'), '2026-08-26');
  });

  it('processMessage rewrites FYI no-reply using the cleaning table', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'FYI_STATEMENT',
            proposedResponse: "You're welcome, Trevor!",
            shouldReply: false,
            confidence: 0.95,
          }),
      },
      requireLiveConversationHistory: false,
    });
    const result = await agent.processMessage(TREVOR_MSG, {
      guestName: 'Trevor',
      checkIn: '2026-08-26T16:00:00-04:00',
      checkOut: '2026-08-28T10:00:00-04:00',
      listingId: APT3_UUID,
      asOfDate: '2026-08-26',
      unitReadiness: {
        isUnitReady: false,
        buttonPressed: false,
        hadPreviousDayGuests: true,
      },
      conversationTraces: { earlyUnitReadyOffered: false, hasRecentHostMessage: true },
    });
    assert.equal(result.shouldReply, true);
    assert.equal(result.typeOfMessageReceived, 'EARLY_CHECKIN');
    assert.match(result.proposedResponse, /not ready yet/i);
    assert.match(result.proposedResponse, /4pm/i);
    assert.doesNotMatch(result.proposedResponse, /cleaning button/i);
    assert.doesNotMatch(result.proposedResponse, /you're welcome/i);
  });
});
