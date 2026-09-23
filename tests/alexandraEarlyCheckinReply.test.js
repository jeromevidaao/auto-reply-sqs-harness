import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

/** Alexandra · Apt Cozy West End Victorian · Sep 17–19 2026 · ~09:36 PT production miss */
const ALEXANDRA_MSG =
  'Hi Jerome- we will arrive in Portland a little early. Is there any possibility of getting into the place around 3? Thanks so much for your consideration!';

const BAD_PRODUCTION_REPLY =
  "Good afternoon, Alexandra. I'll check with the cleaning team and let you know if we can accommodate an earlier arrival around 3pm.";

const alexandraCtx = {
  guestName: 'Alexandra',
  checkIn: '2026-09-17',
  checkOut: '2026-09-19',
  listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
  propertyName: '53 Pine St #3 · Cozy West End Victorian | EV Charging + Parking',
  asOfDate: '2026-09-17',
  asOfInstant: '2026-09-17T12:36:00-04:00',
  nowForGreeting: '2026-09-17T12:36:00-04:00',
  conversationTraces: { earlyUnitReadyOffered: false },
};

function assertStrongEarlyCheckinCopy(text) {
  assert.match(text, /getting the unit ready/i);
  assert.match(text, /cleaning finishes/i);
  assert.match(text, /message you|let you know|we['’]?ll message|we will message/i);
  assert.doesNotMatch(text, /check with the cleaning team/i);
  assert.doesNotMatch(text, /if we can accommodate/i);
}

describe('Alexandra early check-in reply copy (Cozy West End Victorian production miss)', () => {
  it('detects Alexandra early-arrival ask', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._isEarlyCheckinAsk(ALEXANDRA_MSG), true);
    assert.equal(agent._hasWeakEarlyCheckinCopy(BAD_PRODUCTION_REPLY), true);
    assert.equal(agent._hasStrongEarlyCheckinPromise(BAD_PRODUCTION_REPLY), false);
    const nearMiss =
      "Good afternoon, Alexandra. Check-in is at 4pm and we can't guarantee early check-in, but as soon as cleaning finishes we'll message you right away.";
    assert.equal(agent._hasStrongEarlyCheckinPromise(nearMiss), false);
  });

  it('rewrites weak "check with cleaning / if we can accommodate" draft (Alexandra miss)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyEarlyCheckinReplyPolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: BAD_PRODUCTION_REPLY,
        shouldReply: true,
        confidence: 0.9,
      },
      alexandraCtx,
      ALEXANDRA_MSG
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'EARLY_CHECKIN');
    assert.equal(applied.shouldReply, true);
    assertStrongEarlyCheckinCopy(applied.proposedResponse);
    assert.match(applied.proposedResponse, /Alexandra/);
    assert.match(applied.proposedResponse, /cleaning finishes getting the unit ready/i);
  });

  it('leaves Olivia-style strong cleaning-finishes drafts alone', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const good =
      "Good evening, Olivia. Check-in is at 4pm and we can't guarantee early check-in, but as soon as cleaning finishes getting the unit ready for you we'll message you right away. Thanks for the heads-up on your early Sunday departure—we'll note that.";
    const applied = agent._applyEarlyCheckinReplyPolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: good,
        shouldReply: true,
      },
      { guestName: 'Olivia' },
      "Is there any opportunity for an early check in? We'll leave early Sunday so you can start the cleaning process early."
    );
    assert.equal(applied.applied, false);
  });

  it('does not rewrite when host already offered unit ready', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyEarlyCheckinReplyPolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: BAD_PRODUCTION_REPLY,
        shouldReply: true,
      },
      { ...alexandraCtx, conversationTraces: { earlyUnitReadyOffered: true } },
      ALEXANDRA_MSG
    );
    assert.equal(applied.applied, false);
  });
});
