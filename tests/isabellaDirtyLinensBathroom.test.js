import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { checkDraftClaims } from '../src/harness/claimCheck.js';
import { APT2_LISTING_ID, looksLikeInStayExtraLinensTowelsAsk } from '../src/utils/extraLinensTowels.js';
import {
  buildCanonicalDirtyLinenCheckoutReply,
  draftHasDirtyLinenBathroomGuidance,
  looksLikeDirtyLinenDispositionAsk,
} from '../src/utils/dirtyLinenCheckout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

/** Isabella · Cozy West End Victorian / Pine Apt 2 · Sep 23–26 2026 checkout morning */
const ISABELLA_MSG =
  'Are we to change the linens? Where should we put the dirty ones?';

const CHAISE_ONLY =
  'Isabella, extra bath towels and linens are stored under the chaise of the living-room sofa (the long lounge section). Lift the chaise seat up — the lid stays open — and the towels and linens are inside. If you cannot find them, feel free to let us know.';

function makeAgent() {
  return new GuestMessagingAgent({
    projectRoot: projectRootForTests,
    llmAdapter: { complete: async () => '{}' },
  });
}

function isabellaCtx(extra = {}) {
  return {
    guestName: 'Isabella',
    guestDisplayName: 'Isabella',
    checkIn: '2026-09-23',
    checkOut: '2026-09-26',
    guestArrived: true,
    listingId: APT2_LISTING_ID,
    propertyName: 'Cozy West End Victorian · Apt #2',
    asOfDate: '2026-09-26',
    conversationHistory: [
      {
        sender_type: 'host',
        body: CHAISE_ONLY,
      },
    ],
    ...extra,
  };
}

function assertBathroomCanonical(text) {
  assert.match(text, /bathroom floor/i);
  assert.match(text, /strip/i);
  assert.ok(!/linen closet/i.test(text), 'must not mention linen closet');
  assert.ok(!/bathroom sink/i.test(text), 'must not mention bathroom sink');
  assert.ok(
    !(/chaise|lift the chaise|under the (?:living[- ]?room )?sofa/i.test(text) && !/bathroom floor/i.test(text)),
    'must not answer with chaise-only'
  );
}

describe('Isabella dirty linens → bathroom floor (2026-09-26)', () => {
  it('detector catches Isabella change/dirty disposition ask', () => {
    assert.equal(looksLikeDirtyLinenDispositionAsk(ISABELLA_MSG), true);
    assert.equal(draftHasDirtyLinenBathroomGuidance(buildCanonicalDirtyLinenCheckoutReply(isabellaCtx())), true);
  });

  it('does NOT classify Isabella as EXTRA_LINENS_TOWELS find-more', () => {
    assert.equal(looksLikeInStayExtraLinensTowelsAsk(ISABELLA_MSG), false);
    const agent = makeAgent();
    assert.equal(agent._isExtraLinensTowelsInStayAsk(ISABELLA_MSG, isabellaCtx()), false);
  });

  it('still detects Kenneth more-towels as EXTRA_LINENS (not dirty disposition)', () => {
    const kenneth =
      'Hi — we only have 4 towel sets for 5 people. Could we get more bath towels please?';
    assert.equal(looksLikeDirtyLinenDispositionAsk(kenneth), false);
    assert.equal(looksLikeInStayExtraLinensTowelsAsk(kenneth), true);
  });

  it('forces bathroom floor when draft is none / skipped', () => {
    const agent = makeAgent();
    const applied = agent._applyDirtyLinenCheckoutPolicy(
      {
        typeOfMessageReceived: 'OTHER_MESSAGE',
        proposedResponse: 'none',
        shouldReply: false,
        confidence: 0.4,
      },
      isabellaCtx(),
      ISABELLA_MSG
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'CHECKOUT');
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.confidence, 1.0);
    assertBathroomCanonical(applied.proposedResponse);
    assert.match(applied.proposedResponse, /Isabella/i);
  });

  it('rewrites chaise-only draft (anti-repetition / wrong intent) to bathroom floor', () => {
    const agent = makeAgent();
    const applied = agent._applyDirtyLinenCheckoutPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse: CHAISE_ONLY,
      },
      isabellaCtx(),
      ISABELLA_MSG
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'CHECKOUT');
    assertBathroomCanonical(applied.proposedResponse);
    assert.ok(!/chaise/i.test(applied.proposedResponse), 'must not keep chaise how-to as the reply');
  });

  it('extra-linens policy does not apply / rewrite Isabella ask', () => {
    const agent = makeAgent();
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse: CHAISE_ONLY,
      },
      isabellaCtx(),
      ISABELLA_MSG
    );
    assert.equal(applied.applied, false);
  });

  it('claimCheck forces bathroom floor when guidance missing', () => {
    const result = checkDraftClaims({
      draft: 'none',
      decision: { typeOfMessageReceived: 'OTHER_MESSAGE', proposedResponse: 'none' },
      context: isabellaCtx(),
      guestMessage: ISABELLA_MSG,
    });
    assert.ok(
      (result.issues || []).some((i) => i.code === 'dirty_linen_bathroom_missing'),
      `expected dirty_linen_bathroom_missing, got ${JSON.stringify(result.issues)}`
    );
    assert.ok(result.revisedResponse);
    assertBathroomCanonical(result.revisedResponse);
  });

  it('claimCheck does not force sofa rewrite for Isabella dirty ask', () => {
    const result = checkDraftClaims({
      draft: 'Please leave dirty towels in the hallway.',
      decision: { typeOfMessageReceived: 'EXTRA_LINENS_TOWELS', proposedResponse: 'Please leave dirty towels in the hallway.' },
      context: isabellaCtx(),
      guestMessage: ISABELLA_MSG,
    });
    assert.ok(
      !(result.issues || []).some((i) => i.code === 'apt23_extra_linens_wrong_location'),
      'must not force Apt2/3 sofa rewrite on dirty-linen ask'
    );
    assert.ok(result.revisedResponse);
    assertBathroomCanonical(result.revisedResponse);
  });


  it('CleaningIssueTool does not treat dirty-linen disposition as a complaint', async () => {
    const { CleaningIssueTool } = await import('../src/tools/CleaningIssueTool.js');
    const tool = new CleaningIssueTool();
    const result = await tool.execute(ISABELLA_MSG, isabellaCtx());
    assert.equal(result.detected, false, JSON.stringify(result));
    assert.equal(result.blocksAutoReply, false);
  });

  it('cleaning escalation does not wipe dirty-linen CHECKOUT draft', () => {
    const agent = makeAgent();
    const parsed = {
      typeOfMessageReceived: 'CHECKOUT',
      proposedResponse: buildCanonicalDirtyLinenCheckoutReply(isabellaCtx()),
      shouldReply: true,
      confidence: 1.0,
    };
    const cleaningIssue = {
      detected: true,
      matchedPhrase: 'dirty',
      strength: 'strong',
      blocksAutoReply: true,
    };
    const applied = agent._applyCleaningIssueEscalationPolicy(parsed, cleaningIssue, ISABELLA_MSG);
    assert.equal(applied.applied, false);
    assert.match(parsed.proposedResponse, /bathroom floor/i);
  });

  it('canonical snippet includes required eval phrases', () => {
    const snippet = buildCanonicalDirtyLinenCheckoutReply(isabellaCtx());
    assert.match(snippet, /bathroom floor/i);
    assert.match(snippet, /strip/i);
  });
});
