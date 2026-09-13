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
 * Rebecca, West End Victorian, stay ~Sep 9–12 2026:
 * After host asked for a review post-stay, guest thanked + promised a review /
 * loved Portland — production sent NO auto-reply.
 * Expected REVIEW_PROMISE: thank them + reciprocal 5-star because great guests.
 */
describe('Rebecca REVIEW_PROMISE (West End Victorian checkout)', () => {
  const rebeccaMsg =
    "Thanks so much! We'll write a review. We loved Portland!";
  const rebeccaLovedOnly =
    'Thanks Jerome! We loved Portland!';
  const hostReviewAsk =
    'Hope you had a wonderful stay at the West End Victorian! If you have a moment, a 5-star review would mean a lot to us. Thank you! Jerome & Ruby';

  const baseCtx = (asOfDate) => ({
    guestName: 'Rebecca',
    propertyName: 'West End Victorian',
    checkIn: '2026-09-09',
    checkOut: '2026-09-12',
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

  function assertReviewPromiseApplied(applied, label) {
    assert.equal(applied.applied, true, `${label}: policy must apply`);
    assert.equal(applied.shouldReply, true, `${label}: must force shouldReply`);
    assert.equal(applied.typeOfMessageReceived, 'REVIEW_PROMISE', `${label}: category`);
    assert.match(applied.proposedResponse, /you(?:'|’)re welcome|thank you/i);
    assert.match(
      applied.proposedResponse,
      /5\s*-?\s*star|five\s*star|great guests?/i,
      `${label}: reciprocal 5-star / great guests`
    );
    assert.doesNotMatch(
      applied.proposedResponse,
      /locked out|lock\s*box|backup key/i,
      `${label}: must not be lockout`
    );
  }

  for (const asOfDate of ['2026-09-12', '2026-09-13']) {
    const dayLabel = asOfDate === '2026-09-12' ? 'on checkout day' : 'after checkout';

    it(`_applyReviewPromisePolicy: thanks+review+loved Portland ${dayLabel}`, () => {
      const agent = new GuestMessagingAgent({
        projectRoot: projectRootForTests,
        llmAdapter: { complete: async () => '{}' },
      });
      const ctx = baseCtx(asOfDate);
      assert.equal(
        agent._isPostStayGratitudeOrReviewPromise(rebeccaMsg, ctx),
        true,
        `detector must match ${dayLabel}`
      );
      const applied = agent._applyReviewPromisePolicy(
        {
          typeOfMessageReceived: 'THANK_YOU_MESSAGE',
          proposedResponse: 'none',
          shouldReply: false,
          confidence: 0.2,
        },
        ctx,
        rebeccaMsg
      );
      assertReviewPromiseApplied(applied, dayLabel);
    });

    it(`_applyReviewPromisePolicy: thanks+loved Portland (no "review" word) ${dayLabel} when host asked for review`, () => {
      const agent = new GuestMessagingAgent({
        projectRoot: projectRootForTests,
        llmAdapter: { complete: async () => '{}' },
      });
      const ctx = baseCtx(asOfDate);
      assert.equal(
        agent._isPostStayGratitudeOrReviewPromise(rebeccaLovedOnly, ctx),
        true,
        `city-love + thanks must match ${dayLabel} after host review ask`
      );
      const applied = agent._applyReviewPromisePolicy(
        {
          typeOfMessageReceived: 'OTHER_MESSAGE',
          proposedResponse: 'none',
          shouldReply: false,
        },
        ctx,
        rebeccaLovedOnly
      );
      assertReviewPromiseApplied(applied, `loved-only ${dayLabel}`);
    });
  }

  it('processMessage: LLM shouldReply:false / empty none still forces REVIEW_PROMISE (production miss)', async () => {
    const sent = [];
    const hospitableClient = {
      getReservation: async () => null,
      getConversationMessages: async () => [],
      sendMessage: async (payload) => {
        sent.push(payload);
        return { ok: true };
      },
    };

    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      hospitableClient,
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'THANK_YOU_MESSAGE',
            proposedResponse: 'none',
            shouldReply: false,
            confidence: 0.15,
            reason: 'thanks only — no reply needed',
          }),
      },
    });

    const out = await agent.processMessage(rebeccaMsg, baseCtx('2026-09-12'));

    assert.equal(out.shouldReply, true, 'must not stay silent when LLM withholds');
    assert.equal(out.typeOfMessageReceived, 'REVIEW_PROMISE');
    assert.match(String(out.proposedResponse), /you(?:'|’)re welcome/i);
    assert.match(String(out.proposedResponse), /5\s*-?\s*star|review/i);
    assert.match(String(out.proposedResponse), /great guests?|5-star review as well/i);
    assert.equal(sent.length, 0, 'must not send real Hospitable messages in unit test');
  });

  it('processMessage: loved Portland + thanks with LLM silence still replies on checkout day', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      hospitableClient: {
        getReservation: async () => null,
        getConversationMessages: async () => [],
        sendMessage: async () => ({ ok: true }),
      },
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'OTHER_MESSAGE',
            proposedResponse: 'none',
            shouldReply: false,
            confidence: 0.1,
          }),
      },
    });

    const out = await agent.processMessage(rebeccaLovedOnly, baseCtx('2026-09-12'));
    assert.equal(out.shouldReply, true);
    assert.equal(out.typeOfMessageReceived, 'REVIEW_PROMISE');
    assert.match(String(out.proposedResponse), /5\s*-?\s*star|great guests?/i);
  });
});
