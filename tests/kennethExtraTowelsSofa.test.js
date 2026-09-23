import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { checkDraftClaims } from '../src/harness/claimCheck.js';
import {
  APT2_LISTING_ID,
  APT3_LISTING_ID,
  buildCanonicalExtraLinensTowelsReply,
  looksLikeInStayExtraLinensTowelsAsk,
} from '../src/utils/extraLinensTowels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

/** Kenneth · West End Victorian / Pine Apt 2 · Sep 22–25 2026 · party of 5 */
const KENNETH_MSG =
  'Hi — we only have 4 towel sets for 5 people. Could we get more bath towels please?';

const BAD_CLOSET_SINK =
  "Kenneth, thanks for letting us know. Extra bath towels are usually in the linen closet or under the bathroom sink—please check there first. If you still need more, just let me know and I'll bring additional sets right over.";

const BAD_BRING_ONLY = "Kenneth, no problem. I'll bring extra bath towels right over.";

function makeAgent() {
  return new GuestMessagingAgent({
    projectRoot: projectRootForTests,
    llmAdapter: { complete: async () => '{}' },
  });
}

function kennethCtx(extra = {}) {
  return {
    guestName: 'Kenneth',
    guestDisplayName: 'Kenneth',
    checkIn: '2026-09-22',
    checkOut: '2026-09-25',
    guestCount: 5,
    guestArrived: true,
    listingId: APT2_LISTING_ID,
    propertyName: '1875 West End Victorian Apt #2',
    asOfDate: '2026-09-22',
    ...extra,
  };
}

function assertSofaCanonical(text) {
  assert.match(text, /sofa/i);
  assert.match(text, /living[- ]?room|under the (?:living[- ]?room )?sofa/i);
  assert.match(text, /lift/i);
  assert.match(text, /storage|lift/i);
  assert.doesNotMatch(text, /ikea/i);
  assert.ok(!/linen closet/i.test(text), 'must not mention linen closet');
  assert.ok(!/bathroom sink/i.test(text), 'must not mention bathroom sink');
  assert.ok(!/\bcabinets?\b/i.test(text), 'must not mention cabinets as storage');
  assert.ok(!/\bdrawers?\b/i.test(text), 'must not mention drawers as storage');
  assert.ok(
    !/i(?:'|’)ll bring .{0,40}right over|bring (?:extra |additional )?(?:bath )?towels? right over/i.test(
      text
    ),
    'must not promise host bring-over as first reply'
  );
  assert.match(text, /feel free to let us know|cannot find|can't find|let (?:us|me) know/i);
}

describe('Kenneth Apt 2 extra towels → sofa lift-up (2026-09-22)', () => {
  it('detector catches Kenneth shortfall / more bath towels ask', () => {
    assert.equal(looksLikeInStayExtraLinensTowelsAsk(KENNETH_MSG), true);
    const agent = makeAgent();
    assert.equal(agent._isExtraLinensTowelsInStayAsk(KENNETH_MSG, kennethCtx()), true);
  });

  it('rewrites linen-closet / bathroom-sink draft to sofa lift-up (Apt 2)', () => {
    const agent = makeAgent();
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse: BAD_CLOSET_SINK,
      },
      kennethCtx(),
      KENNETH_MSG
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'EXTRA_LINENS_TOWELS');
    assertSofaCanonical(applied.proposedResponse);
    assert.match(applied.proposedResponse, /Kenneth/i);
  });

  it('rewrites premature bring-right-over draft (Apt 2)', () => {
    const agent = makeAgent();
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse: BAD_BRING_ONLY,
      },
      kennethCtx(),
      KENNETH_MSG
    );
    assert.equal(applied.applied, true);
    assertSofaCanonical(applied.proposedResponse);
  });

  it('Apt 3 same sofa facts (parametrized twin)', () => {
    const agent = makeAgent();
    const ctx = kennethCtx({
      listingId: APT3_LISTING_ID,
      propertyName: 'Cozy West End Victorian Apt 3',
      guestName: 'Alex',
      guestDisplayName: 'Alex',
    });
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse:
          'Extra towels are in the linen closet or under the bathroom sink. Check the cabinets.',
      },
      ctx,
      'We need more bath towels — only 4 for 5 people.'
    );
    assert.equal(applied.applied, true);
    assertSofaCanonical(applied.proposedResponse);
    assert.match(applied.proposedResponse, /Alex/i);
  });

  it('does not invent sofa rewrite for Studio/1B', () => {
    const agent = makeAgent();
    const ctx = kennethCtx({
      listingId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
      propertyName: 'Downtown Studio 1B',
    });
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'MISC_QUESTION',
        proposedResponse: 'Please check the linen closet for extras.',
      },
      ctx,
      'Where are extra towels?'
    );
    // Studio is not Apt 2/3 sofa path — either no apply or no sofa rewrite from this policy.
    if (applied.applied && applied.proposedResponse) {
      assert.ok(
        !/living-room sofa/i.test(applied.proposedResponse) || applied.applied !== true,
        'must not force Apt2/3 sofa copy onto Studio'
      );
    }
  });

  it('still appends follow-up when sofa guidance present but no offer (Sean)', () => {
    const agent = makeAgent();
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse:
          'Good evening, Sean, yes there are extra clean towels under the sofa bed. Lift up the long part of the sofa to reveal them along with the linens.',
      },
      kennethCtx({ guestName: 'Sean', guestDisplayName: 'Sean' }),
      'Hi, are there more clean towels in the unit?'
    );
    assert.equal(applied.applied, true);
    assert.ok(applied.proposedResponse.includes('feel free to let us know'));
    assert.ok(/under the sofa|Lift up the long part/i.test(applied.proposedResponse));
    assert.ok(!/linen closet|bathroom sink/i.test(applied.proposedResponse));
  });

  it('does not double-append when already correct + follow-up', () => {
    const agent = makeAgent();
    const good = buildCanonicalExtraLinensTowelsReply(kennethCtx());
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse: good,
      },
      kennethCtx(),
      KENNETH_MSG
    );
    assert.equal(applied.applied, false);
  });


  it('normalizes TOWEL_REQUEST alias to EXTRA_LINENS_TOWELS when draft already correct', () => {
    const agent = makeAgent();
    const good = buildCanonicalExtraLinensTowelsReply(kennethCtx());
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'TOWEL_REQUEST',
        proposedResponse: good,
      },
      kennethCtx(),
      KENNETH_MSG
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'EXTRA_LINENS_TOWELS');
    assertSofaCanonical(applied.proposedResponse);
  });

  it('claimCheck REVISE wrong closet/sink for Apt 2 EXTRA_LINENS', () => {
    const r = checkDraftClaims({
      draft: BAD_CLOSET_SINK,
      guestMessage: KENNETH_MSG,
      context: kennethCtx(),
      decision: { typeOfMessageReceived: 'EXTRA_LINENS_TOWELS' },
    });
    assert.ok(r.issues.some((i) => i.code === 'apt23_extra_linens_wrong_location'));
    assert.ok(r.revisedResponse);
    assertSofaCanonical(r.revisedResponse);
  });

  it('deterministic judge guard forces REVISE on wrong location', () => {
    const agent = makeAgent();
    const guarded = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', notes: 'ok', issues: [] },
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse: BAD_CLOSET_SINK,
        shouldReply: true,
      },
      kennethCtx(),
      KENNETH_MSG
    );
    assert.equal(guarded.verdict, 'REVISE');
    assertSofaCanonical(guarded.revisedResponse);
  });
});
