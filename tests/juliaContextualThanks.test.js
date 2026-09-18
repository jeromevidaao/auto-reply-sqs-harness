import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

/** Exact guest message from Julia · Downtown Studio Parking with EV, stay Sep 17–20. */
const JULIA_GUEST =
  "So far so good!! I'll reach out if needed. TYSM! Julia";

const JULIA_HOST_CHECKIN =
  'Good morning Julia, I hope that you have settled in after your travel and that you are enjoying your stay. Please let me know if there is anything you need. Don\'t forget to check out the Portland guidebook in the apartment for local tips. Jerome & Ruby';

const juliaCtx = {
  guestName: 'Julia',
  guestDisplayName: 'Julia',
  checkIn: '2026-09-17',
  checkOut: '2026-09-20',
  asOfDate: '2026-09-18',
  propertyName: 'Downtown Studio Parking with EV',
  conversation_id: 'julia-morning-checkin-thanks-conv',
  conversationHistory: [
    {
      sender_type: 'host',
      body: JULIA_HOST_CHECKIN,
    },
    {
      sender_type: 'guest',
      body: JULIA_GUEST,
    },
  ],
};

function assertContextualThanks(body, label) {
  assert.match(body, /you(?:'|\u2019)?re welcome/i, `${label}: need You're welcome`);
  assert.match(
    body,
    /enjoying (?:your |the )?stay|glad you|settled/i,
    `${label}: need enjoying-stay / glad you / settled context (bare You're welcome alone fails)`
  );
  assert.ok(
    !/^you(?:'|\u2019)?re welcome,?\s+\w+!?\s*$/i.test(body.trim()),
    `${label}: bare "You're welcome, Julia!" alone must FAIL`
  );
}

describe('Julia morning check-in thanks — contextual You\'re welcome (not bare)', () => {
  it('infers enjoying-stay thank-you context from host check-in + guest positive', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const inferred = agent._inferThankYouContext(JULIA_GUEST, juliaCtx);
    assert.ok(inferred, 'must infer thank-you context');
    assert.equal(inferred.reason, 'enjoying_stay');
    assert.match(inferred.clause || '', /enjoying|glad you|settled/i);
  });

  it('policy enriches thin You\'re welcome with enjoying-stay context', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyContextualThankYouPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Julia!",
        shouldReply: true,
      },
      juliaCtx,
      JULIA_GUEST
    );
    assert.equal(applied.applied, true);
    assertContextualThanks(applied.proposedResponse, 'policy');
  });

  it('processMessage: thin LLM draft becomes contextual thanks (Hospitable mocked)', async () => {
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

    const out = await agent.processMessage(JULIA_GUEST, {
      ...juliaCtx,
      requireLiveConversationHistory: false,
    });
    assert.equal(out.shouldReply, true);
    assertContextualThanks(out.proposedResponse, 'processMessage');
  });

  it('Amie temporary departure stays bare (no enjoying-stay enrichment)', () => {
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
      conversationHistory: [
        {
          sender_type: 'host',
          body: 'I hope you are enjoying your stay. I found 1 blanket.',
        },
        { sender_type: 'guest', body: amie },
      ],
    };
    const applied = agent._applyContextualThankYouPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Amie!",
        shouldReply: true,
      },
      amieCtx,
      amie
    );
    assert.equal(applied.applied, false, 'contextual policy must not fire for Amie step-out');
  });

  it('Rene post-welcome logistics thanks stays bare (no re-send / no forced context)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const rene =
      'Thank you so much! I appreciate your prompt response! We are super excited!';
    const reneCtx = {
      guestName: 'Rene',
      checkIn: '2026-06-29',
      checkOut: '2026-07-02',
      conversationTraces: { recentWelcomeSent: true },
      conversationHistory: [
        {
          sender_type: 'host',
          body:
            'Good afternoon, Rene, Check-in is at 4pm with self-check-in and you have one dedicated off-street parking spot. Looking forward to hosting you.',
        },
        { sender_type: 'guest', body: rene },
      ],
    };
    const applied = agent._applyContextualThankYouPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Rene!",
        shouldReply: true,
      },
      reneCtx,
      rene
    );
    assert.equal(applied.applied, false, 'contextual policy must not override Rene bare ack');
  });

  it('policy rewrites enjoying-context draft that omitted You\'re welcome', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyContextualThankYouPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "Glad you're enjoying your stay, Julia!",
        shouldReply: true,
      },
      juliaCtx,
      JULIA_GUEST
    );
    assert.equal(applied.applied, true);
    assertContextualThanks(applied.proposedResponse, 'missing-youre-welcome');
  });

  it('TYSM counts as thank-you intent so stripFalseYoureWelcome keeps opener', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._hasThankYouIntent(JULIA_GUEST), true);
    const kept = agent._stripFalseYoureWelcome(
      "You're welcome, Julia! Glad you're enjoying your stay.",
      JULIA_GUEST
    );
    assert.match(kept, /you(?:'|\u2019)?re welcome/i);
    assert.match(kept, /enjoying/i);
  });
});
