import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { setHostContactsForTests, TEST_HOST_CONTACTS } from '../src/config/hostContacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

/** Production Richard phone Jerome wants in the combined Sara reply. */
const RICHARD_PHONE = '(207) 807-8071';

setHostContactsForTests({
  ...TEST_HOST_CONTACTS,
  richardPhonePrimary: RICHARD_PHONE,
  richardPhoneDisplay: RICHARD_PHONE,
  richardPhoneAlt: RICHARD_PHONE,
});
process.env.ALLOW_HOST_CONTACT_TEST_DEFAULTS = '1';

const hasGrokKey = !!process.env.GROK_API_KEY;

/**
 * Sara · Cozy West End Victorian · Sep 20–22 2026 · ~14:17 PT production miss
 * Guest preferred later checkout (flight 5pm) and referenced luggage / hotel first night.
 * Production auto-reply ONLY answered luggage and missed late-checkout refusal.
 * Jerome: never grant late checkout (cleaning / next guests). Refuse + luggage OK in one reply.
 */
const SARA_MSG =
  "Actually, I'm just realizing the better request was to see if we can get a later checkout, since our flight out is 5pm. Would much prefer that, if I had a choice between the two, as we could keep our luggage at the hotel that first night. I'm recognizing this may be a lot, so really happy with either consideration! Thank you.";

/** Jerome's canonical late-checkout refuse copy (required / golden). */
const JEROME_LATE_CHECKOUT_REFUSE =
  'Sorry we cannot allow late checkout because we have guests right after you and the cleaning team needs this time to get the unit ready for them';

const BAD_PRODUCTION_LUGGAGE_ONLY =
  `Good evening, Sara, thank you! Yes, you can coordinate an early luggage drop-off with Richard, our on-site property manager, at ${RICHARD_PHONE}.`;

const saraCtx = {
  guestName: 'Sara',
  guestDisplayName: 'Sara',
  checkIn: '2026-09-20',
  checkOut: '2026-09-22',
  listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
  airbnbListingId: '24259977',
  propertyName: '53 Pine St #3 · Cozy West End Victorian | EV Charging + Parking',
  asOfDate: '2026-09-18',
  asOfInstant: '2026-09-18T14:17:00-07:00',
  nowForGreeting: '2026-09-18T14:17:00-07:00',
  reservationId: 'sara-cozy-west-end-2026-09-20',
  conversation_id: 'sara-late-checkout-luggage-conv',
  conversationTraces: {
    earlyUnitReadyOffered: false,
    hasRecentHostMessage: true,
    greeting: { isFirstHostMessage: false, numHostMessages: 3 },
  },
  conversationHistory: [
    {
      role: 'host',
      sender_type: 'host',
      body: 'Hi Sara! The Wifi network is Pineland and the password is lobsterbake.',
      content: 'Hi Sara! The Wifi network is Pineland and the password is lobsterbake.',
    },
    {
      role: 'guest',
      sender_type: 'guest',
      body: 'Wonderful! I love your WiFi password! :)\n\nAny chance we can check-in earlier?',
      content: 'Wonderful! I love your WiFi password! :)\n\nAny chance we can check-in earlier?',
    },
    {
      role: 'host',
      sender_type: 'host',
      body: "Good afternoon, Sara. Check-in is at 4pm and we can't guarantee early check-in, but as soon as cleaning finishes getting the unit ready for you we'll message you right away.",
      content: "Good afternoon, Sara. Check-in is at 4pm and we can't guarantee early check-in, but as soon as cleaning finishes getting the unit ready for you we'll message you right away.",
    },
  ],
  requireLiveConversationHistory: false,
};

function assertLateCheckoutRefuse(text, label = 'reply') {
  const body = String(text || '');
  assert.ok(body && body.toLowerCase() !== 'none', `${label}: must have a sendable draft`);
  assert.match(
    body,
    /Sorry we cannot allow late checkout because we have guests right after you and the cleaning team needs this time to get the unit ready for them/i,
    `${label}: Jerome canonical late-checkout refuse`
  );
  // Do not treat "cannot allow late checkout" as a grant ("we can" is a prefix of "we cannot").
  assert.doesNotMatch(
    body,
    /\bwe can (?!not )(?:definitely |certainly )?(?:allow|offer|do|accommodate) .{0,20}late checkout|\b(?:happy to|no problem|sure[,!]?) .{0,40}late checkout|late checkout(?: is)? (?:ok|fine|available|approved)|\bcheckout at (?:11|12|1|2|3|noon)/i,
    `${label}: NEVER grant later checkout`
  );
}

function assertLuggageRichard(text, label = 'reply') {
  const body = String(text || '');
  assert.match(body, /Richard/i, `${label}: Richard`);
  assert.match(body, /807-8071|207\)?\s*807/, `${label}: Richard phone (207) 807-8071`);
  assert.match(body, /luggage/i, `${label}: luggage`);
}

function assertCombinedSaraReply(text, label = 'reply') {
  assertLateCheckoutRefuse(text, label);
  assertLuggageRichard(text, label);
}

function catsOf(v) {
  return Array.isArray(v) ? v : [v];
}

function mockHospitable(sent) {
  return {
    getReservation: async () => null,
    getConversationMessages: async () => [],
    getReservations: async () => [],
    sendMessage: async (conversationId, body) => {
      sent.push({ method: 'sendMessage', conversationId, body });
      return { ok: true };
    },
    sendMessageToReservation: async (reservationId, body) => {
      sent.push({ method: 'sendMessageToReservation', reservationId, body });
      return { ok: true };
    },
  };
}

describe('Sara late checkout + luggage (Cozy West End Victorian production miss)', () => {
  it('detects late-checkout ask AND luggage from the exact guest text', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._isLateCheckoutAsk(SARA_MSG), true, 'later checkout / flight 5pm');
    assert.equal(agent._isLuggageRequest(SARA_MSG), true, 'luggage at the hotel that first night');
  });

  it('_mergeCategories always allows multi categories (late checkout + luggage)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const merged = agent._mergeCategories('LUGGAGE_DROP_OFF', 'LATE_CHECKOUT', 'THANK_YOU_MESSAGE');
    const cats = catsOf(merged);
    assert.ok(cats.includes('LATE_CHECKOUT'), `got ${JSON.stringify(cats)}`);
    assert.ok(cats.includes('LUGGAGE_DROP_OFF'), `got ${JSON.stringify(cats)}`);
    assert.ok(cats.length >= 2, 'multi categories retained');
  });

  it('Jerome refuse snippet is the canonical late-checkout refusal', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const snippet = agent._lateCheckoutRefuseSnippet(saraCtx, SARA_MSG);
    assert.match(snippet, new RegExp(JEROME_LATE_CHECKOUT_REFUSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    assert.match(snippet, /10\s*AM/i);
  });

  it('thin luggage-only draft must FAIL coverage until multi-intent fix; policy then combines', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    let parsed = {
      typeOfMessageReceived: 'LUGGAGE_DROP_OFF',
      proposedResponse: BAD_PRODUCTION_LUGGAGE_ONLY,
      shouldReply: true,
      confidence: 0.95,
    };

    const luggageOnly = agent._applyLuggagePolicy(parsed, saraCtx, SARA_MSG);
    if (luggageOnly.applied) {
      parsed = { ...parsed, ...luggageOnly, shouldReply: true };
    }
    const thinCats = catsOf(parsed.typeOfMessageReceived);
    const thinBody = String(parsed.proposedResponse || '');
    const thinMissesLate =
      !thinCats.includes('LATE_CHECKOUT') ||
      !/cannot allow late checkout|cleaning team needs this time/i.test(thinBody);
    assert.equal(
      thinMissesLate,
      true,
      'precondition: luggage-only path must still be missing late-checkout before multi-intent runs'
    );

    const multi = agent._applyLateCheckoutLuggageMultiIntentPolicy(parsed, saraCtx, SARA_MSG);
    assert.equal(multi.applied, true, 'multi-intent policy must rewrite luggage-only miss');
    parsed = {
      ...parsed,
      typeOfMessageReceived: multi.typeOfMessageReceived,
      proposedResponse: multi.proposedResponse,
      shouldReply: true,
    };
    const cats = catsOf(parsed.typeOfMessageReceived);
    assert.ok(
      cats.some((c) => String(c).includes('LATE_CHECKOUT')),
      `categories must include LATE_CHECKOUT, got ${JSON.stringify(cats)}`
    );
    assert.ok(
      cats.some((c) => String(c).includes('LUGGAGE')),
      `categories must include luggage, got ${JSON.stringify(cats)}`
    );
    assertCombinedSaraReply(parsed.proposedResponse, 'post multi-intent policy');
  });

  it('processMessage: LLM luggage-only draft becomes refuse late checkout + Richard luggage', async () => {
    const sent = [];
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      hospitableClient: mockHospitable(sent),
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'LUGGAGE_DROP_OFF',
            proposedResponse: BAD_PRODUCTION_LUGGAGE_ONLY,
            shouldReply: true,
            confidence: 0.95,
            reason: 'luggage drop-off',
          }),
      },
    });

    const out = await agent.processMessage(SARA_MSG, saraCtx);
    assert.equal(out.shouldReply, true);
    assertCombinedSaraReply(out.proposedResponse, 'processMessage');
    const cats = catsOf(out.typeOfMessageReceived);
    assert.ok(
      cats.some((c) => String(c).includes('LATE_CHECKOUT')),
      `got ${JSON.stringify(cats)}`
    );
    assert.ok(cats.some((c) => String(c).includes('LUGGAGE')), `got ${JSON.stringify(cats)}`);

    await agent.hospitableClient.sendMessage(saraCtx.conversation_id, out.proposedResponse);
    assert.equal(sent.length, 1);
    assertCombinedSaraReply(sent[0].body, 'send payload');
  });

  it(
    'live Grok: Sara → late-checkout refuse + Richard luggage (Hospitable mocked)',
    { skip: !hasGrokKey },
    async () => {
      const sent = [];
      const agent = new GuestMessagingAgent({
        projectRoot: projectRootForTests,
        llm: 'auto',
        hospitableClient: mockHospitable(sent),
        enableReflection: true,
        enableConversationJudge: true,
      });

      const out = await agent.processMessage(SARA_MSG, {
        ...saraCtx,
        requireLiveConversationHistory: false,
      });

      assert.equal(out.shouldReply, true, 'must auto-reply');
      assertCombinedSaraReply(out.proposedResponse, 'live Grok');

      await agent.hospitableClient.sendMessage(saraCtx.conversation_id, out.proposedResponse);
      assert.equal(sent.length, 1);
      assertCombinedSaraReply(sent[0].body, 'live Grok send payload');
    }
  );
});
