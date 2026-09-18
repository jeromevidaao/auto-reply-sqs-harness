import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

/** Exact guest thank-you after early-check-in auto-reply (Carli · Booker / Pineland). */
const CARLI_GUEST = 'Thankyou so much :) appreciate it!';

const CARLI_HOST_EARLY =
  "Good afternoon, Carli. Check-in is at 4pm and we can't guarantee early check-in, but as soon as cleaning finishes getting the unit ready for you we'll message you right away.";

const carliCtx = {
  guestName: 'Carli',
  guestDisplayName: 'Carli',
  checkIn: '2026-09-18',
  checkOut: '2026-09-20',
  asOfDate: '2026-09-18',
  propertyName: 'Booker / Pine',
  conversation_id: 'carli-early-checkin-thanks-conv',
  conversationHistory: [
    {
      sender_type: 'guest',
      body: "Hello! If there's any chance of na early check in, would you let me know please. Thankyou!",
    },
    {
      sender_type: 'host',
      body: CARLI_HOST_EARLY,
    },
    {
      sender_type: 'guest',
      body: CARLI_GUEST,
    },
  ],
};

function assertContextualEarlyCheckinThanks(body, label) {
  assert.match(body, /you(?:'|\u2019)?re welcome/i, `${label}: need You're welcome`);
  assert.match(
    body,
    /glad we can update|happy to help|will (?:message|update)|update you/i,
    `${label}: need short early-checkin context (glad we can update / happy to help)`
  );
  assert.ok(
    !/^you(?:'|\u2019)?re welcome,?\s+\w+!?\s*$/i.test(body.trim()),
    `${label}: bare "You're welcome, Carli!" alone must FAIL`
  );
  assert.ok(!/4\s*pm/i.test(body), `${label}: must NOT re-explain 4pm`);
  assert.ok(
    !/can'?t guarantee early|cleaning finishes/i.test(body),
    `${label}: must NOT restate early-checkin policy`
  );
}

describe('Carli early-checkin thanks — Thankyou + contextual You\'re welcome', () => {
  it('matches one-word Thankyou! as thank-you intent (bare miss without compound regex)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._hasThankYouIntent('Thankyou!'), true);
    assert.equal(agent._hasThankYouIntent(CARLI_GUEST), true);
    assert.equal(agent._hasThankYouIntent('thx'), true);
    assert.equal(agent._hasThankYouIntent('ty'), true);
    assert.equal(agent._hasThankYouIntent('tysm'), true);
    assert.equal(agent._hasThankYouIntent('appreciate it'), true);
  });

  it('infers will_update / happy_to_help from host early-checkin answer + guest Thankyou', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const inferred = agent._inferThankYouContext(CARLI_GUEST, carliCtx);
    assert.ok(inferred, 'must infer thank-you context (bare miss: null)');
    assert.ok(
      inferred.reason === 'will_update' || inferred.reason === 'happy_to_help',
      `expected will_update|happy_to_help, got ${inferred.reason}`
    );
    assert.match(inferred.clause || '', /glad we can update|happy to help|update you/i);
  });

  it('early-checkin host answer is NOT treated as full welcome (Rene path must not bare-ack Carli)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(
      agent._hostMessageLooksLikeEarlyCheckinAnswer(CARLI_HOST_EARLY),
      true
    );
    assert.equal(
      agent._isPostWelcomeThankYouFollowUp(CARLI_GUEST, carliCtx),
      false,
      'post-welcome must not swallow early-checkin thanks'
    );
  });

  it('policy enriches thin You\'re welcome with early-checkin update context', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyContextualThankYouPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Carli!",
        shouldReply: true,
      },
      carliCtx,
      CARLI_GUEST
    );
    assert.equal(applied.applied, true, 'contextual policy must fire (bare miss: applied false)');
    assertContextualEarlyCheckinThanks(applied.proposedResponse, 'policy');
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
            proposedResponse: "You're welcome, Carli!",
            shouldReply: true,
            confidence: 0.95,
          }),
      },
    });

    const out = await agent.processMessage(CARLI_GUEST, {
      ...carliCtx,
      requireLiveConversationHistory: false,
    });
    assert.equal(out.shouldReply, true);
    assertContextualEarlyCheckinThanks(out.proposedResponse, 'processMessage');
  });

  it('Amie temporary departure stays bare (no early-checkin enrichment)', () => {
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

  it('Rene post-welcome logistics thanks stays bare (no early-checkin context forced)', () => {
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
});
