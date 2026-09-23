import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { checkDraftClaims } from '../src/harness/claimCheck.js';
import {
  checkInInstructionsSendYmd,
  formatGuestFriendlyMonthDay,
  resolveCheckInInstructionsTiming,
} from '../src/utils/checkInInstructionsDates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

const CYNTHIA_ASK =
  'Jerome, I just need to get instructions on how to get into the unit when we arrive on Oct. 3rd. Thank you, Cynthia';
const CYNTHIA_WHERE =
  "OK, you'll send it on this text just as you did this one correct? Perfect thank you Cynthia.";
const BAD_DEFERRAL =
  "Cynthia — you're welcome. You're all set for October 3rd, and I'll send the entry instructions before you arrive so you have clear steps for getting into the unit. Message me if anything else comes up before then.";

const cynthiaCtx = {
  guestName: 'Cynthia',
  guestDisplayName: 'Cynthia',
  checkIn: '2026-10-03T16:00:00-04:00',
  checkOut: '2026-10-04T10:00:00-04:00',
  listingId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
  propertyName: 'Downtown Studio, Walk Everywhere, Parking',
  asOfDate: '2026-09-23',
  asOfInstant: '2026-09-23T15:41:00-07:00',
  nowForGreeting: '2026-09-23T18:41:00-04:00',
};

function agentForTests() {
  return new GuestMessagingAgent({
    projectRoot: projectRootForTests,
    llmAdapter: { complete: async () => '{}' },
  });
}

describe('check-in instructions date helpers (Cynthia Oct 3 → Sept 30)', () => {
  it('computes send day as check-in minus 3 calendar days', () => {
    assert.equal(checkInInstructionsSendYmd('2026-10-03'), '2026-09-30');
    assert.equal(formatGuestFriendlyMonthDay('2026-09-30'), 'September 30');
  });

  it('defers when >3 days out; immediate when ≤3', () => {
    const defer = resolveCheckInInstructionsTiming({
      checkIn: '2026-10-03',
      asOfDate: '2026-09-23',
    });
    assert.equal(defer.shouldDefer, true);
    assert.equal(defer.sendLabel, 'September 30');
    assert.equal(defer.daysUntilCheckIn, 10);

    const onSendDay = resolveCheckInInstructionsTiming({
      checkIn: '2026-10-03',
      asOfDate: '2026-09-30',
    });
    assert.equal(onSendDay.shouldDefer, false);
    assert.equal(onSendDay.daysUntilCheckIn, 3);

    const twoDaysOut = resolveCheckInInstructionsTiming({
      checkIn: '2026-10-03',
      asOfDate: '2026-10-01',
    });
    assert.equal(twoDaysOut.shouldDefer, false);
  });
});

describe('Cynthia check-in / entry instructions deferral policy', () => {
  it('detects entry-instructions ask and channel follow-up', () => {
    const agent = agentForTests();
    assert.equal(agent._isCheckInInstructionsAsk(CYNTHIA_ASK), true);
    assert.equal(agent._isCheckInInstructionsChannelAsk(CYNTHIA_WHERE), true);
    assert.equal(agent._isCheckInInstructionsAsk('Where is the nearest coffee shop?'), false);
  });

  it('rewrites vague "before you arrive" deferral to name September 30 + 3 days', () => {
    const agent = agentForTests();
    const applied = agent._applyCheckInInstructionsAskPolicy(
      {
        typeOfMessageReceived: 'CHECK_IN_INSTRUCTIONS',
        proposedResponse: BAD_DEFERRAL,
        shouldReply: true,
        confidence: 0.9,
      },
      cynthiaCtx,
      CYNTHIA_ASK
    );
    assert.equal(applied.applied, true);
    const cats = Array.isArray(applied.typeOfMessageReceived)
      ? applied.typeOfMessageReceived
      : [applied.typeOfMessageReceived];
    assert.ok(cats.includes('CHECK_IN_INSTRUCTIONS'));
    assert.match(applied.proposedResponse, /September 30/);
    assert.match(applied.proposedResponse, /3 days/i);
    assert.match(applied.proposedResponse, /on September 30/i);
    assert.doesNotMatch(applied.proposedResponse, /before you arrive/i);
  });

  it('channel follow-up confirms this conversation + September 30', () => {
    const agent = agentForTests();
    const ctx = {
      ...cynthiaCtx,
      conversationHistory: [
        { sender_type: 'guest', body: CYNTHIA_ASK },
        { sender_type: 'host', body: BAD_DEFERRAL },
      ],
    };
    const applied = agent._applyCheckInInstructionsAskPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome!",
        shouldReply: true,
      },
      ctx,
      CYNTHIA_WHERE
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /September 30/);
    assert.match(
      applied.proposedResponse,
      /same (?:conversation|thread|text)|this (?:same )?(?:conversation|thread|text)/i
    );
  });

  it('within 3 days does not promise September 30 — uses immediate language', () => {
    const agent = agentForTests();
    const near = {
      ...cynthiaCtx,
      asOfDate: '2026-10-01',
      asOfInstant: '2026-10-01T10:00:00-04:00',
    };
    const applied = agent._applyCheckInInstructionsAskPolicy(
      {
        typeOfMessageReceived: 'CHECK_IN_INSTRUCTIONS',
        proposedResponse: BAD_DEFERRAL,
        shouldReply: true,
      },
      near,
      CYNTHIA_ASK
    );
    assert.equal(applied.applied, true);
    assert.doesNotMatch(applied.proposedResponse, /September 30/);
    assert.match(
      applied.proposedResponse,
      /shortly|right away|in this (?:same )?(?:conversation|thread)|now/i
    );
  });
});

describe('claimCheck: check-in instructions deferral must name send date', () => {
  it('flags vague before-you-arrive deferral and forces September 30 copy', () => {
    const r = checkDraftClaims({
      draft: BAD_DEFERRAL,
      guestMessage: CYNTHIA_ASK,
      context: cynthiaCtx,
      decision: { typeOfMessageReceived: 'CHECK_IN_INSTRUCTIONS' },
    });
    assert.ok(r.issues.some((i) => i.code === 'check_in_instructions_deferral_missing_date'));
    assert.match(r.revisedResponse || '', /September 30/);
    assert.match(r.revisedResponse || '', /3 days/i);
  });
});
