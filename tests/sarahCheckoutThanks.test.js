import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

const SARAH_CHECKOUT_THANKS =
  'We have checked out. Thank you for a great stay!';

const sarahCtx = {
  guestName: 'Sarah',
  guestDisplayName: 'Sarah',
  checkIn: '2026-09-17',
  checkOut: '2026-09-18',
  propertyName: 'Cozy West End Victorian',
  conversation_id: 'sarah-checkout-thanks-conv',
};

function assertWarmCheckoutThanks(body, label) {
  assert.match(body, /you(?:'|\u2019)?re welcome/i, `${label}: need You're welcome`);
  assert.match(
    body,
    /(thank|thanks).{0,50}(stay|staying)|glad you (enjoyed|had)|hope you enjoyed/i,
    `${label}: need thanks-for-staying / glad you enjoyed`
  );
  assert.match(
    body,
    /safe travels|hope to see you|see you again/i,
    `${label}: need safe travels or hope to see you again`
  );
  assert.ok(
    (body.match(/[.!?]/g) || []).length >= 2 || body.split(/[.!?]/).filter((s) => s.trim().length > 8).length >= 2,
    `${label}: need more than one sentence (bare You're welcome is too thin)`
  );
}

describe('Sarah checkout thanks — warm multi-sentence (not bare You\'re welcome)', () => {
  it('detects post-checkout thank-you for Sarah exact message', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._looksLikeActualCheckout(SARAH_CHECKOUT_THANKS, sarahCtx), true);
    assert.equal(agent._isPostCheckoutThankYou(SARAH_CHECKOUT_THANKS, sarahCtx), true);
  });

  it('policy enriches thin You\'re welcome into warm checkout thanks', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyPostCheckoutThankYouPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Sarah!",
        shouldReply: true,
      },
      sarahCtx,
      SARAH_CHECKOUT_THANKS
    );
    assert.equal(applied.applied, true);
    assertWarmCheckoutThanks(applied.proposedResponse, 'policy');
  });

  it('processMessage: thin LLM draft becomes warm checkout thanks (Hospitable mocked)', async () => {
    const sent = [];
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      hospitableClient: {
        sendMessage: async (id, body) => {
          sent.push({ id, body });
          return { ok: true };
        },
        getConversationMessages: async () => [],
      },
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'THANK_YOU_MESSAGE',
            proposedResponse: "You're welcome, Sarah!",
            shouldReply: true,
            confidence: 0.95,
          }),
      },
    });

    const out = await agent.processMessage(SARAH_CHECKOUT_THANKS, {
      ...sarahCtx,
      requireLiveConversationHistory: false,
    });
    assert.equal(out.shouldReply, true);
    assertWarmCheckoutThanks(out.proposedResponse, 'processMessage');
  });

  it('Amie in-stay temporary departure must NOT get safe travels', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const amie = 'Thank you we just left the apartment!';
    const amieCtx = {
      guestName: 'Amie',
      checkIn: '2026-06-19',
      checkOut: '2026-06-21',
      asOfDate: '2026-06-19',
      stayTiming: 'current',
    };
    assert.equal(agent._isTemporaryDepartureDuringStay(amie, amieCtx), true);
    assert.equal(agent._isPostCheckoutThankYou(amie, amieCtx), false);
    const applied = agent._applyPostCheckoutThankYouPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Amie!",
        shouldReply: true,
      },
      amieCtx,
      amie
    );
    assert.equal(applied.applied, false, 'post-checkout policy must not fire for Amie step-out');
  });

  it('review promise must not override Sarah checkout thanks category', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._isPostStayGratitudeOrReviewPromise(SARAH_CHECKOUT_THANKS, sarahCtx), false);
    const review = agent._applyReviewPromisePolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Sarah! Thanks for staying with us — glad you had a great stay. Safe travels!",
        shouldReply: true,
      },
      sarahCtx,
      SARAH_CHECKOUT_THANKS
    );
    assert.equal(review.applied, false);
  });
});