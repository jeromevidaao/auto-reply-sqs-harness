import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

/** Julia · Downtown Studio checkout ~2026-09-20 — exact production wording. */
const JULIA_CHECKOUT_HOSTING =
  'Jerome. We are all checked out. Thanks for hosting!!';

const juliaCtx = {
  guestName: 'Julia',
  guestDisplayName: 'Julia',
  checkIn: '2026-09-18',
  checkOut: '2026-09-20',
  asOfDate: '2026-09-20',
  propertyName: 'Downtown Studio',
  conversation_id: 'julia-checkout-hosting-conv',
  // Production Schlage PIN unlock from check-in day — must NOT demote checkout thanks.
  guestArrived: true,
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
    (body.match(/[.!?]/g) || []).length >= 2 ||
      body.split(/[.!?]/).filter((s) => s.trim().length > 8).length >= 2,
    `${label}: need more than one sentence (bare You're welcome is too thin)`
  );
  assert.ok(
    !/^you(?:'|\u2019)?re welcome,?\s+\w+!?\s*$/i.test(body.trim()),
    `${label}: bare "You're welcome, Julia!" alone must FAIL`
  );
}

describe('Julia checkout thanks-for-hosting — warm farewell (not bare You\'re welcome)', () => {
  it('detects "all checked out" + "thanks for hosting" as post-checkout thank-you', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._looksLikeActualCheckout(JULIA_CHECKOUT_HOSTING, juliaCtx), true);
    assert.equal(agent._isPostCheckoutThankYou(JULIA_CHECKOUT_HOSTING, juliaCtx), true);
    assert.equal(
      agent._isTemporaryDepartureDuringStay(JULIA_CHECKOUT_HOSTING, juliaCtx),
      false,
      'must not treat Julia as Amie-style temporary departure'
    );
  });

  it('detects thanks-for-hosting / thanks-for-hosting-us as checkout gratitude phrases', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const hostingUs = 'We checked out. Thanks for hosting us!!';
    assert.equal(agent._looksLikeActualCheckout(hostingUs, juliaCtx), true);
    assert.equal(agent._isPostCheckoutThankYou(hostingUs, juliaCtx), true);
    // On checkout day, "Thanks for hosting!" alone (no "checked out") still counts.
    assert.equal(agent._looksLikeActualCheckout('Thanks for hosting!', juliaCtx), true);
    assert.equal(agent._isPostCheckoutThankYou('Thanks for hosting us!', juliaCtx), true);
  });

  it('policy enriches thin You\'re welcome into warm checkout thanks', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyPostCheckoutThankYouPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Julia!",
        shouldReply: true,
      },
      juliaCtx,
      JULIA_CHECKOUT_HOSTING
    );
    assert.equal(applied.applied, true);
    assertWarmCheckoutThanks(applied.proposedResponse, 'policy');
  });

  it('in-stay see-you-soon must NOT overwrite warm checkout farewell when guestArrived', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const warm =
      "You're welcome, Julia! Thanks for staying with us — glad you had a great stay. Safe travels!";
    // Simulate: post-checkout already enriched, then in-stay policy runs (bug path).
    const seeYou = agent._applyInStaySeeYouSoonPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: warm,
        shouldReply: true,
      },
      juliaCtx,
      JULIA_CHECKOUT_HOSTING
    );
    assert.equal(
      seeYou.applied,
      false,
      'in-stay see-you-soon must not apply on post-checkout thanks (guestArrived trap)'
    );
  });

  it('processMessage with guestArrived: thin LLM draft stays warm (not stripped to bare)', async () => {
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
            proposedResponse: "You're welcome, Julia!",
            shouldReply: true,
            confidence: 0.95,
          }),
      },
    });

    const out = await agent.processMessage(JULIA_CHECKOUT_HOSTING, {
      ...juliaCtx,
      requireLiveConversationHistory: false,
    });
    assert.equal(out.shouldReply, true);
    assertWarmCheckoutThanks(out.proposedResponse, 'processMessage+guestArrived');
  });

  it('deterministic judge guard REVISES bare You\'re welcome on post-checkout thanks-for-hosting', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const firstDecision = {
      typeOfMessageReceived: 'THANK_YOU_MESSAGE',
      proposedResponse: "You're welcome, Julia!",
      shouldReply: true,
      confidence: 0.95,
    };
    const guarded = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', notes: 'ok' },
      firstDecision,
      juliaCtx,
      JULIA_CHECKOUT_HOSTING
    );
    assert.equal(guarded.verdict, 'REVISE', 'judge must REVISE bare You\'re welcome on checkout thanks');
    assertWarmCheckoutThanks(guarded.revisedResponse, 'judge-guard');
  });

  it('Amie in-stay temporary departure still excluded (no safe travels)', () => {
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
      guestArrived: true,
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
});
