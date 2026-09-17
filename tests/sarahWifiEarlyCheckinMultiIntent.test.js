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

const hasGrokKey = !!process.env.GROK_API_KEY;

/**
 * Sarah / Sara · Cozy West End Victorian · Sep 20–22 2026 · ~15:32 PT production miss
 * Guest complimented WiFi password AND asked for earlier check-in.
 * Production auto-reply only covered WiFi credentials and dropped early check-in entirely.
 */
const SARAH_MSG =
  'Wonderful! I love your WiFi password! :)\n\nAny chance we can check-in earlier? We will be in Portland, as we arrive on the 19th and will stay at a hotel the first night.\n\nThank you!\n\nSara';

const BAD_PRODUCTION_WIFI_ONLY =
  "You're welcome, Sara! The WiFi network is Ansia_2.4 and the password is 10286500 (all lowercase). Let me know if it works.";

const PRIOR_HOST_WIFI =
  'Hi Sara! The WiFi network is Ansia_2.4 and the password is 10286500 (all lowercase). Looking forward to hosting you.';

const sarahCtx = {
  guestName: 'Sara',
  guestDisplayName: 'Sara',
  checkIn: '2026-09-20',
  checkOut: '2026-09-22',
  listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
  propertyName: '53 Pine St #3 · Cozy West End Victorian | EV Charging + Parking',
  asOfDate: '2026-09-17',
  asOfInstant: '2026-09-17T15:32:00-07:00',
  nowForGreeting: '2026-09-17T15:32:00-07:00',
  reservationId: 'sarah-cozy-west-end-2026-09-20',
  conversation_id: 'sarah-wifi-early-checkin-conv',
  // Prior host turn so first-host welcome policy does not wipe multi-intent (prod already had thread).
  conversationTraces: {
    earlyUnitReadyOffered: false,
    hasRecentHostMessage: true,
    greeting: { isFirstHostMessage: false, numHostMessages: 2 },
  },
  conversationHistory: [
    {
      role: 'host',
      sender_type: 'host',
      body: PRIOR_HOST_WIFI,
      content: PRIOR_HOST_WIFI,
    },
    {
      role: 'guest',
      sender_type: 'guest',
      body: 'Thanks!',
      content: 'Thanks!',
    },
  ],
  requireLiveConversationHistory: false,
};

function assertCoversWifiAndEarlyCheckin(text, label = 'reply') {
  const body = String(text || '');
  assert.ok(body && body.toLowerCase() !== 'none', `${label}: must have a sendable draft`);
  // WiFi / password acknowledgment OR credentials
  assert.match(
    body,
    /wifi|wi-?fi|password|network/i,
    `${label}: must acknowledge WiFi / password`
  );
  // Alexandra early-check-in policy (not vague "check with cleaning")
  assert.match(body, /cleaning finishes|getting the unit ready|unit ready/i, `${label}: early check-in ready promise`);
  assert.match(body, /message you|let you know|we['’]?ll message|we will message/i, `${label}: will message`);
  assert.match(body, /4\s*(:00)?\s*pm/i, `${label}: states 4pm check-in`);
  assert.doesNotMatch(body, /check with the cleaning team/i, `${label}: no weak cleaning-team copy`);
  assert.doesNotMatch(body, /if we can accommodate/i, `${label}: no weak accommodate copy`);
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

describe('Sarah WiFi compliment + early check-in multi-intent (Cozy West End Victorian production miss)', () => {
  it('detects early-check-in ask AND wifi compliment (not a password ask)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._isEarlyCheckinAsk(SARAH_MSG), true);
    assert.equal(agent._isWifiCompliment(SARAH_MSG), true, 'love your WiFi password is a compliment');
    assert.equal(
      agent._isWifiPasswordAsk(SARAH_MSG),
      false,
      'compliment must not be treated as password ask (that overwrote early check-in in prod)'
    );
    assert.equal(agent._hasThankYouIntent(SARAH_MSG), true);
  });

  it('policy path: production wifi-only draft is rewritten to cover BOTH intents', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    // Reproduce the production post-policy order: early applies, then wifi used to wipe it.
    let parsed = {
      typeOfMessageReceived: 'WIFI_PASSWORD',
      proposedResponse: BAD_PRODUCTION_WIFI_ONLY,
      shouldReply: true,
      confidence: 0.9,
    };
    const early = agent._applyEarlyCheckinReplyPolicy(parsed, sarahCtx, SARAH_MSG);
    if (early.applied) {
      parsed = { ...parsed, ...early, shouldReply: true };
    }
    const wifi = agent._applyWifiPolicy(parsed, sarahCtx, SARAH_MSG);
    if (wifi.applied) {
      parsed = {
        ...parsed,
        typeOfMessageReceived: wifi.typeOfMessageReceived,
        proposedResponse: wifi.proposedResponse,
        shouldReply: true,
      };
    }
    const multi = agent._applyWifiEarlyCheckinMultiIntentPolicy(parsed, sarahCtx, SARAH_MSG);
    if (multi.applied) {
      parsed = {
        ...parsed,
        typeOfMessageReceived: multi.typeOfMessageReceived,
        proposedResponse: multi.proposedResponse,
        shouldReply: true,
      };
    }
    assertCoversWifiAndEarlyCheckin(parsed.proposedResponse, 'post-policy');
    const cats = Array.isArray(parsed.typeOfMessageReceived)
      ? parsed.typeOfMessageReceived
      : [parsed.typeOfMessageReceived];
    assert.ok(
      cats.some((c) => ['EARLY_CHECKIN', 'EARLY_CHECKIN_QUESTION', 'CHECK_IN_TIME_QUESTION'].includes(c)),
      `categories must include early check-in, got ${JSON.stringify(cats)}`
    );
  });

  it('processMessage: LLM wifi-only draft still covers both (Hospitable mocked, LLM stubbed)', async () => {
    const sent = [];
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      hospitableClient: mockHospitable(sent),
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'WIFI_PASSWORD',
            proposedResponse: BAD_PRODUCTION_WIFI_ONLY,
            shouldReply: true,
            confidence: 0.95,
            reason: 'wifi password compliment',
          }),
      },
    });

    const out = await agent.processMessage(SARAH_MSG, sarahCtx);
    assert.equal(out.shouldReply, true);
    assertCoversWifiAndEarlyCheckin(out.proposedResponse, 'processMessage');

    // Simulate Lambda send decision with the proposed draft (assert send payload).
    const convId = sarahCtx.conversation_id;
    const body = out.proposedResponse;
    await agent.hospitableClient.sendMessage(convId, body);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].conversationId, convId);
    assertCoversWifiAndEarlyCheckin(sent[0].body, 'send payload');
  });

  it(
    'live Grok: Sarah multi-intent covers WiFi ack + early check-in (Hospitable mocked)',
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

      const out = await agent.processMessage(SARAH_MSG, {
        ...sarahCtx,
        // Keep history empty / non-live so we do not hit real Hospitable GETs.
        requireLiveConversationHistory: false,
      });

      assert.equal(out.shouldReply, true, 'must auto-reply');
      assertCoversWifiAndEarlyCheckin(out.proposedResponse, 'live Grok');

      await agent.hospitableClient.sendMessage(sarahCtx.conversation_id, out.proposedResponse);
      assert.equal(sent.length, 1, 'mock Hospitable must record the send');
      assertCoversWifiAndEarlyCheckin(sent[0].body, 'live Grok send payload');
    }
  );
});
