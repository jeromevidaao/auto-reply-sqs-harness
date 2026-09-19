import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { setHostContactsForTests, TEST_HOST_CONTACTS } from '../src/config/hostContacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

setHostContactsForTests(TEST_HOST_CONTACTS);
process.env.ALLOW_HOST_CONTACT_TEST_DEFAULTS = '1';

/**
 * Alexandra, West End Victorian / Cozy West End, Sep 17–19 2026:
 * Host asked for a 5-star review post-stay. Guest: "Thanks again, Jerome! You got 5!"
 * Production sent only thin THANK_YOU: "You're welcome, Alexandra!"
 * Missed: acknowledge the 5-star promise + thank them + reciprocal 5-star (REVIEW_PROMISE).
 */
describe('Alexandra REVIEW_PROMISE (You got 5! after host review ask)', () => {
  const alexandraMsg = 'Thanks again, Jerome! You got 5!';
  const hostReviewAsk =
    'Hope you had a wonderful stay at the West End Victorian! If you have a moment, a 5-star review would mean a lot to us. Thank you! Jerome & Ruby';

  const baseCtx = (asOfDate) => ({
    guestName: 'Alexandra',
    propertyName: 'Cozy West End Victorian',
    checkIn: '2026-09-17',
    checkOut: '2026-09-19',
    asOfDate,
    conversationHistory: [
      {
        role: 'host',
        sender_type: 'host',
        body: hostReviewAsk,
        content: hostReviewAsk,
      },
    ],
    requireLiveConversationHistory: false,
  });

  function assertReviewPromiseEnriched(applied, label) {
    assert.equal(applied.applied, true, `${label}: policy must apply`);
    assert.equal(applied.shouldReply, true, `${label}: must force shouldReply`);
    const cats = applied.typeOfMessageReceived;
    const catOk =
      cats === 'REVIEW_PROMISE' ||
      (Array.isArray(cats) && cats.includes('REVIEW_PROMISE'));
    assert.ok(catOk, `${label}: category must include REVIEW_PROMISE, got ${JSON.stringify(cats)}`);
    assert.match(applied.proposedResponse, /you(?:'|’)re welcome/i);
    assert.match(
      applied.proposedResponse,
      /5\s*-?\s*star|five\s*star/i,
      `${label}: must thank / acknowledge 5 stars`
    );
    assert.match(
      applied.proposedResponse,
      /leave you a 5|5-star review as well|great guests?/i,
      `${label}: reciprocal 5-star promise`
    );
    assert.doesNotMatch(
      applied.proposedResponse,
      /^you(?:'|’)re welcome,?\s+alexandra!?\s*$/i,
      `${label}: bare You're welcome, Alexandra! alone must FAIL`
    );
  }

  for (const asOfDate of ['2026-09-19', '2026-09-20']) {
    const dayLabel = asOfDate === '2026-09-19' ? 'on checkout day' : 'after checkout';

    it(`detector: "You got 5!" + thanks + prior host review-ask ${dayLabel}`, () => {
      const agent = new GuestMessagingAgent({
        projectRoot: projectRootForTests,
        llmAdapter: { complete: async () => '{}' },
      });
      assert.equal(
        agent._isPostStayGratitudeOrReviewPromise(alexandraMsg, baseCtx(asOfDate)),
        true,
        `detector must match ${dayLabel}`
      );
    });

    it(`_applyReviewPromisePolicy: enriches thin You're welcome ${dayLabel}`, () => {
      const agent = new GuestMessagingAgent({
        projectRoot: projectRootForTests,
        llmAdapter: { complete: async () => '{}' },
      });
      const applied = agent._applyReviewPromisePolicy(
        {
          typeOfMessageReceived: 'THANK_YOU_MESSAGE',
          proposedResponse: "You're welcome, Alexandra!",
          shouldReply: true,
          confidence: 0.9,
        },
        baseCtx(asOfDate),
        alexandraMsg
      );
      assertReviewPromiseEnriched(applied, dayLabel);
    });
  }

  it('phrase variants: you got five / 5 stars / five stars count as review promise', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const ctx = baseCtx('2026-09-19');
    for (const msg of [
      'Thanks again, Jerome! You got 5!',
      'Thanks Jerome — you got five!',
      'Thank you! 5 stars for you.',
      'Thanks! You got 5 stars.',
      'Thanks again — five stars!',
    ]) {
      assert.equal(
        agent._isPostStayGratitudeOrReviewPromise(msg, ctx),
        true,
        `must detect: ${msg}`
      );
    }
  });

  it('processMessage: LLM thin THANK_YOU still forces REVIEW_PROMISE with reciprocal 5-star', async () => {
    const sent = [];
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      hospitableClient: {
        getReservation: async () => null,
        getConversationMessages: async () => [],
        sendMessage: async (payload) => {
          sent.push(payload);
          return { ok: true };
        },
      },
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'THANK_YOU_MESSAGE',
            proposedResponse: "You're welcome, Alexandra!",
            shouldReply: true,
            confidence: 0.95,
            reason: 'thanks only',
          }),
      },
    });

    const out = await agent.processMessage(alexandraMsg, baseCtx('2026-09-19'));

    assert.equal(out.shouldReply, true);
    const cats = out.typeOfMessageReceived;
    const catOk =
      cats === 'REVIEW_PROMISE' ||
      (Array.isArray(cats) && cats.includes('REVIEW_PROMISE'));
    assert.ok(catOk, `got ${JSON.stringify(cats)}`);
    assert.match(String(out.proposedResponse), /you(?:'|’)re welcome/i);
    assert.match(String(out.proposedResponse), /5\s*-?\s*star|five\s*star/i);
    assert.match(String(out.proposedResponse), /leave you a 5|as well|great guests?/i);
    assert.doesNotMatch(
      String(out.proposedResponse).trim(),
      /^you(?:'|’)re welcome,?\s+alexandra!?\s*$/i
    );
    assert.equal(sent.length, 0, 'must not send real Hospitable messages in unit test');
  });

  it('judge guard: REVISE bare You\'re welcome when guest promised 5 stars', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const firstDecision = {
      typeOfMessageReceived: 'THANK_YOU_MESSAGE',
      proposedResponse: "You're welcome, Alexandra!",
      shouldReply: true,
    };
    const guarded = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', confidence: 0.9, issues: [], notes: 'ok' },
      firstDecision,
      baseCtx('2026-09-19'),
      alexandraMsg
    );
    assert.equal(guarded.verdict, 'REVISE');
    assert.match(String(guarded.revisedResponse), /5\s*-?\s*star|five\s*star/i);
    assert.match(String(guarded.revisedResponse), /leave you a 5|as well|great guests?/i);
    assert.ok(
      (guarded.issues || []).some((i) => /5.?star|review promise|reciprocal/i.test(i)),
      'issues must mention review/5-star miss'
    );
  });
});
