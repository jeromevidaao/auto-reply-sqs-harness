import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { setHostContactsForTests, TEST_HOST_CONTACTS } from '../src/config/hostContacts.js';
import { wifiCredentialsFromCheckinTemplate } from '../src/useCases/checkinTemplates/index.js';
import { NON_CANONICAL_WIFI_FIXTURE } from './fixtures/forbiddenPineWifi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

// Inject the known-wrong production globals so tests prove we never emit them for Pine.
setHostContactsForTests({
  ...TEST_HOST_CONTACTS,
  wifiSsid: NON_CANONICAL_WIFI_FIXTURE.ssid,
  wifiPassword: NON_CANONICAL_WIFI_FIXTURE.password,
});
process.env.ALLOW_HOST_CONTACT_TEST_DEFAULTS = '1';

const hasGrokKey = !!process.env.GROK_API_KEY;

/**
 * Sarah / Sara · Cozy West End Victorian · Sep 20–22 2026 · ~15:32 PT production miss
 * Guest complimented WiFi password AND asked for earlier check-in.
 * Production auto-reply dumped wrong global non-canonical WiFi and dropped early check-in.
 */
const SARAH_MSG =
  'Wonderful! I love your WiFi password! :)\n\nAny chance we can check-in earlier? We will be in Portland, as we arrive on the 19th and will stay at a hotel the first night.\n\nThank you!\n\nSara';

const BAD_PRODUCTION_WIFI_ONLY =
  "You're welcome, Sara! The WiFi network is WRONG_SSID and the password is wrong-password (all lowercase). Let me know if it works.";

const WIFI_COMPLIMENT_ONLY = 'Wonderful! I love your WiFi password! :)';

const sarahCtx = {
  guestName: 'Sara',
  guestDisplayName: 'Sara',
  checkIn: '2026-09-20',
  checkOut: '2026-09-22',
  listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
  airbnbListingId: '24259977',
  propertyName: '53 Pine St #3 · Cozy West End Victorian | EV Charging + Parking',
  asOfDate: '2026-09-17',
  asOfInstant: '2026-09-17T15:32:00-07:00',
  nowForGreeting: '2026-09-17T15:32:00-07:00',
  reservationId: 'sarah-cozy-west-end-2026-09-20',
  conversation_id: 'sarah-wifi-early-checkin-conv',
  conversationTraces: {
    earlyUnitReadyOffered: false,
    hasRecentHostMessage: true,
    greeting: { isFirstHostMessage: false, numHostMessages: 2 },
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
      body: 'Thanks!',
      content: 'Thanks!',
    },
  ],
  requireLiveConversationHistory: false,
};

function assertClassicEarlyCheckin(text, label = 'reply') {
  const body = String(text || '');
  assert.ok(body && body.toLowerCase() !== 'none', `${label}: must have a sendable draft`);
  assert.match(body, /getting the unit ready/i, `${label}: must include exact phrase "getting the unit ready"`);
  assert.match(body, /cleaning finishes/i, `${label}: cleaning finishes`);
  assert.match(body, /message you|let you know|we['’]?ll message|we will message/i, `${label}: will message`);
  assert.match(body, /4\s*(:00)?\s*pm/i, `${label}: states 4pm check-in`);
  assert.doesNotMatch(body, /check with the cleaning team/i, `${label}: no weak cleaning-team copy`);
  assert.doesNotMatch(body, /if we can accommodate/i, `${label}: no weak accommodate copy`);
  assert.doesNotMatch(body, /WRONG_SSID/i, `${label}: never WRONG_SSID`);
  assert.doesNotMatch(body, /wrong-password/, `${label}: never wrong-password`);
  // Compliment is not a password ask — do not dump credentials.
  assert.doesNotMatch(
    body,
    /wifi\s+network\s+is|password\s+is\s+\S+/i,
    `${label}: must not dump WiFi credentials on a compliment`
  );
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

describe('Sarah WiFi compliment + early check-in (Cozy West End Victorian production miss)', () => {
  it('check-in templates resolve Pineland/lobsterbake for Apt 3 / Pine / West End', () => {
    const creds = wifiCredentialsFromCheckinTemplate(sarahCtx);
    assert.ok(creds);
    assert.equal(creds.ssid, 'Pineland');
    assert.equal(creds.password, 'lobsterbake');
  });

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
      'compliment must not be treated as password ask'
    );
  });

  it('Sarah exact message → EARLY_CHECKIN classic; never non-canonical WiFi / never credential dump', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
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
    assert.equal(wifi.applied, false, 'wifi policy must not fire on compliment');
    const multi = agent._applyWifiEarlyCheckinMultiIntentPolicy(parsed, sarahCtx, SARAH_MSG);
    if (multi.applied) {
      parsed = {
        ...parsed,
        typeOfMessageReceived: multi.typeOfMessageReceived,
        proposedResponse: multi.proposedResponse,
        shouldReply: true,
      };
    }
    assertClassicEarlyCheckin(parsed.proposedResponse, 'post-policy');
    const cats = Array.isArray(parsed.typeOfMessageReceived)
      ? parsed.typeOfMessageReceived
      : [parsed.typeOfMessageReceived];
    assert.ok(
      cats.some((c) => ['EARLY_CHECKIN', 'EARLY_CHECKIN_QUESTION', 'CHECK_IN_TIME_QUESTION'].includes(c)),
      `categories must include EARLY_CHECKIN, got ${JSON.stringify(cats)}`
    );
    assert.ok(
      !cats.includes('WIFI_PASSWORD'),
      `compliment+early must not stay WIFI_PASSWORD, got ${JSON.stringify(cats)}`
    );
  });

  it('Pine St / West End: wifi credentials from policy are Pineland/lobsterbake never non-canonical WiFi', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const pineContexts = [
      {
        guestName: 'Sara',
        listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
        airbnbListingId: '24259977',
        propertyName: '53 Pine St #3 · Cozy West End Victorian | EV Charging + Parking',
        conversationHistory: [],
      },
      {
        guestName: 'Jane',
        listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
        propertyName: '53 Pine St #2 · 1875 West End Victorian | EV Charging + Parking',
        conversationHistory: [],
      },
      {
        guestName: 'Sam',
        listingId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
        airbnbListingId: '20904545',
        propertyName: 'Downtown Studio · 53 Pine St Apt 1B',
        conversationHistory: [],
      },
    ];
    for (const ctx of pineContexts) {
      const { ssid, password } = agent._wifiCredentials(ctx);
      assert.equal(ssid, 'Pineland', `ssid for ${ctx.propertyName}`);
      assert.equal(password, 'lobsterbake', `password for ${ctx.propertyName}`);
      assert.notEqual(ssid, NON_CANONICAL_WIFI_FIXTURE.ssid);
      assert.notEqual(password, NON_CANONICAL_WIFI_FIXTURE.password);
      const applied = agent._applyWifiPolicy(
        { typeOfMessageReceived: 'OTHER_MESSAGE', proposedResponse: 'none', shouldReply: false },
        ctx,
        'What is the wifi password?'
      );
      assert.equal(applied.applied, true, `policy should apply for ${ctx.propertyName}`);
      assert.match(applied.proposedResponse, /Pineland/i);
      assert.match(applied.proposedResponse, /lobsterbake/i);
      assert.doesNotMatch(applied.proposedResponse, /WRONG_SSID/i);
      assert.doesNotMatch(applied.proposedResponse, /wrong-password/);
    }
  });

  it('WiFi compliment alone → warm ack, NOT credential dump', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const multi = agent._applyWifiEarlyCheckinMultiIntentPolicy(
      {
        typeOfMessageReceived: 'WIFI_PASSWORD',
        proposedResponse: BAD_PRODUCTION_WIFI_ONLY,
        shouldReply: true,
      },
      sarahCtx,
      WIFI_COMPLIMENT_ONLY
    );
    assert.equal(multi.applied, true);
    assert.match(multi.proposedResponse, /glad you like the wifi|you're welcome/i);
    assert.doesNotMatch(multi.proposedResponse, /WRONG_SSID|wrong-password|pineland|lobsterbake|password is/i);
  });

  it('processMessage: LLM wifi-only draft becomes EARLY_CHECKIN classic (Hospitable mocked)', async () => {
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
    assertClassicEarlyCheckin(out.proposedResponse, 'processMessage');
    const cats = Array.isArray(out.typeOfMessageReceived)
      ? out.typeOfMessageReceived
      : [out.typeOfMessageReceived];
    assert.ok(cats.some((c) => String(c).includes('EARLY_CHECKIN')), `got ${JSON.stringify(cats)}`);

    await agent.hospitableClient.sendMessage(sarahCtx.conversation_id, out.proposedResponse);
    assert.equal(sent.length, 1);
    assertClassicEarlyCheckin(sent[0].body, 'send payload');
  });

  it(
    'live Grok: Sarah → EARLY_CHECKIN classic, never non-canonical WiFi (Hospitable mocked)',
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
        requireLiveConversationHistory: false,
      });

      assert.equal(out.shouldReply, true, 'must auto-reply');
      assertClassicEarlyCheckin(out.proposedResponse, 'live Grok');

      await agent.hospitableClient.sendMessage(sarahCtx.conversation_id, out.proposedResponse);
      assert.equal(sent.length, 1);
      assertClassicEarlyCheckin(sent[0].body, 'live Grok send payload');
    }
  );

  it('near-miss "cleaning finishes … message you" without "getting the unit ready" is rewritten (CI flake)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const nearMiss =
      "Good afternoon, Sara. Check-in is at 4pm and we can't guarantee early check-in, but as soon as cleaning finishes we'll message you right away.";
    assert.equal(
      agent._hasStrongEarlyCheckinPromise(nearMiss),
      false,
      'near-miss must NOT count as strong (missing getting the unit ready)'
    );
    let parsed = {
      typeOfMessageReceived: ['THANK_YOU_MESSAGE', 'FYI_STATEMENT', 'EARLY_CHECKIN'],
      proposedResponse: nearMiss,
      shouldReply: true,
      confidence: 0.95,
    };
    const early = agent._applyEarlyCheckinReplyPolicy(parsed, sarahCtx, SARAH_MSG);
    assert.equal(early.applied, true, 'early policy must rewrite near-miss');
    parsed = { ...parsed, ...early, shouldReply: true };
    const multi = agent._applyWifiEarlyCheckinMultiIntentPolicy(parsed, sarahCtx, SARAH_MSG);
    if (multi.applied) {
      parsed = {
        ...parsed,
        typeOfMessageReceived: multi.typeOfMessageReceived,
        proposedResponse: multi.proposedResponse,
        shouldReply: true,
      };
    }
    assertClassicEarlyCheckin(parsed.proposedResponse, 'near-miss rewritten');
  });

});
