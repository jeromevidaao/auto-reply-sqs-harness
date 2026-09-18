import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { checkDraftClaims } from '../src/harness/claimCheck.js';
import { setHostContactsForTests, TEST_HOST_CONTACTS } from '../src/config/hostContacts.js';
import {
  NON_CANONICAL_WIFI_FIXTURE,
  badNonCanonicalWifiDump,
} from './fixtures/forbiddenPineWifi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

setHostContactsForTests({
  ...TEST_HOST_CONTACTS,
  wifiSsid: NON_CANONICAL_WIFI_FIXTURE.ssid,
  wifiPassword: NON_CANONICAL_WIFI_FIXTURE.password,
});
process.env.ALLOW_HOST_CONTACT_TEST_DEFAULTS = '1';

/**
 * Non-Sarah guest (Mia) — WiFi-knows detection is guest/property-agnostic
 * and driven by conversation history (not Sarah-specific matching).
 */
const MIA_COMPLIMENT_EARLY =
  'Love the wifi password! Can we arrive early? Thanks!';

const MIA_EARLY_ONLY = 'Any chance we can check in a bit early tomorrow?';

const BAD_WIFI_DUMP = badNonCanonicalWifiDump('Mia');

const HOST_SENT_PINELAND = [
  {
    role: 'host',
    sender_type: 'host',
    body: 'Hi Mia! The Wifi network is Pineland and the password is lobsterbake.',
    content: 'Hi Mia! The Wifi network is Pineland and the password is lobsterbake.',
  },
];

const PRIOR_GUEST_WIFI_WORKS = [
  {
    role: 'host',
    sender_type: 'host',
    body: 'The Wifi network is Pineland and the password is lobsterbake.',
    content: 'The Wifi network is Pineland and the password is lobsterbake.',
  },
  {
    role: 'guest',
    sender_type: 'guest',
    body: 'wifi works great — thanks!',
    content: 'wifi works great — thanks!',
  },
];

const miaCtxBase = {
  guestName: 'Mia',
  guestDisplayName: 'Mia',
  checkIn: '2026-09-20',
  checkOut: '2026-09-22',
  listingId: 'mia-listing-uuid-0001',
  propertyName: 'Harbor View Studio',
  asOfDate: '2026-09-17',
  asOfInstant: '2026-09-17T16:00:00-07:00',
  nowForGreeting: '2026-09-17T16:00:00-07:00',
  reservationId: 'mia-wifi-knows-2026-09-20',
  conversation_id: 'mia-wifi-knows-conv',
  conversationTraces: {
    earlyUnitReadyOffered: false,
    hasRecentHostMessage: true,
    greeting: { isFirstHostMessage: false, numHostMessages: 1 },
  },
  requireLiveConversationHistory: false,
};

function assertClassicEarlyCheckin(text, label = 'reply') {
  const body = String(text || '');
  assert.ok(body && body.toLowerCase() !== 'none', `${label}: must have a sendable draft`);
  assert.match(
    body,
    /cleaning finishes|getting the unit ready|unit ready/i,
    `${label}: early check-in ready promise`
  );
  assert.match(
    body,
    /message you|let you know|we['’]?ll message|we will message/i,
    `${label}: will message`
  );
  assert.match(body, /4\s*(:00)?\s*pm/i, `${label}: states 4pm check-in`);
  assert.doesNotMatch(body, /WRONG_SSID/i, `${label}: never WRONG_SSID`);
  assert.doesNotMatch(body, /wrong-password/, `${label}: never wrong-password`);
  assert.doesNotMatch(
    body,
    /wifi\s+network\s+is|password\s+is\s+\S+/i,
    `${label}: must not dump WiFi credentials when guest already knows WiFi`
  );
}

function catsOf(parsed) {
  const raw = parsed.typeOfMessageReceived;
  return Array.isArray(raw) ? raw : [raw];
}

function makeAgent() {
  return new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
}

describe('Mia (non-Sarah): guest already knows WiFi from conversation history', () => {
  it('_guestSignalsKnowsWifi / _guestAlreadyKnowsWifiFromConversation are guest-agnostic', () => {
    const agent = makeAgent();
    assert.equal(agent._guestSignalsKnowsWifi('Love the wifi password!'), true);
    assert.equal(agent._guestSignalsKnowsWifi('wifi works great'), true);
    assert.equal(agent._guestSignalsKnowsWifi('we are online now'), true);
    assert.equal(agent._guestSignalsKnowsWifi('What is the wifi password?'), false);

    const ctx = { ...miaCtxBase, conversationHistory: HOST_SENT_PINELAND };
    assert.equal(
      agent._guestAlreadyKnowsWifiFromConversation(MIA_COMPLIMENT_EARLY, ctx),
      true,
      'compliment + host history → knows wifi'
    );
    assert.equal(
      agent._guestAlreadyKnowsWifiFromConversation(MIA_EARLY_ONLY, {
        ...miaCtxBase,
        conversationHistory: PRIOR_GUEST_WIFI_WORKS,
      }),
      true,
      'prior guest "wifi works" → knows wifi even without wifi words in current msg'
    );
    assert.equal(
      agent._guestAlreadyKnowsWifiFromConversation('What is the wifi password?', ctx),
      false,
      'explicit ask overrides knows-wifi'
    );
  });

  it('Mia: host WiFi then compliment+early → EARLY_CHECKIN classic, multi-category, no credentials', () => {
    const agent = makeAgent();
    const ctx = { ...miaCtxBase, conversationHistory: HOST_SENT_PINELAND };
    let parsed = {
      typeOfMessageReceived: 'WIFI_PASSWORD',
      proposedResponse: BAD_WIFI_DUMP,
      shouldReply: true,
      confidence: 0.9,
    };
    const wifi = agent._applyWifiPolicy(parsed, ctx, MIA_COMPLIMENT_EARLY);
    assert.equal(wifi.applied, false, 'wifi policy must not fire when guest knows wifi');
    const multi = agent._applyWifiEarlyCheckinMultiIntentPolicy(parsed, ctx, MIA_COMPLIMENT_EARLY);
    assert.equal(multi.applied, true, 'multi-intent should apply');
    parsed = {
      ...parsed,
      typeOfMessageReceived: multi.typeOfMessageReceived,
      proposedResponse: multi.proposedResponse,
      shouldReply: true,
    };
    assertClassicEarlyCheckin(parsed.proposedResponse, 'mia compliment+early');
    const cats = catsOf(parsed);
    assert.ok(
      cats.some((c) =>
        ['EARLY_CHECKIN', 'EARLY_CHECKIN_QUESTION', 'CHECK_IN_TIME_QUESTION'].includes(c)
      ),
      `must include EARLY_CHECKIN, got ${JSON.stringify(cats)}`
    );
    assert.ok(
      !cats.includes('WIFI_PASSWORD'),
      `must not collapse to WIFI_PASSWORD, got ${JSON.stringify(cats)}`
    );
  });

  it('Mia: prior guest "wifi works great" then early ask → no wifi dump; keep EARLY_CHECKIN', () => {
    const agent = makeAgent();
    const ctx = { ...miaCtxBase, conversationHistory: PRIOR_GUEST_WIFI_WORKS };
    let parsed = {
      typeOfMessageReceived: 'EARLY_CHECKIN',
      proposedResponse: `${BAD_WIFI_DUMP} Check-in is at 4pm.`,
      shouldReply: true,
      confidence: 0.9,
    };
    assert.equal(agent._guestAlreadyKnowsWifiFromConversation(MIA_EARLY_ONLY, ctx), true);
    const wifi = agent._applyWifiPolicy(parsed, ctx, MIA_EARLY_ONLY);
    assert.equal(wifi.applied, false, 'must not inject credentials after prior wifi-works ack');
    const multi = agent._applyWifiEarlyCheckinMultiIntentPolicy(parsed, ctx, MIA_EARLY_ONLY);
    if (multi.applied) {
      parsed = {
        ...parsed,
        typeOfMessageReceived: multi.typeOfMessageReceived,
        proposedResponse: multi.proposedResponse,
      };
    }
    const body = String(parsed.proposedResponse || '');
    assert.doesNotMatch(body, /wifi\s+network\s+is|password\s+is\s+\S+|WRONG_SSID|wrong-password/i);
    const cats = catsOf(parsed);
    assert.ok(
      cats.some((c) => String(c).includes('EARLY_CHECKIN')),
      `categories must keep EARLY_CHECKIN, got ${JSON.stringify(cats)}`
    );
    assert.ok(!cats.includes('WIFI_PASSWORD'), `must not force WIFI_PASSWORD, got ${JSON.stringify(cats)}`);
  });

  it('claimCheck: Mia wifi dump after known → wifi_resend_after_known + early classic', () => {
    const r = checkDraftClaims({
      draft: BAD_WIFI_DUMP,
      guestMessage: MIA_COMPLIMENT_EARLY,
      context: { conversationHistory: HOST_SENT_PINELAND, guestDisplayName: 'Mia' },
    });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'wifi_resend_after_known'));
    assert.match(
      r.revisedResponse || '',
      /cleaning finishes|message you right away|can'?t guarantee early/i
    );
    assert.doesNotMatch(r.revisedResponse || '', /WRONG_SSID|wrong-password|password is/i);
  });

  it('claimCheck: prior guest wifi-works then early ask + dump → strip, no credentials', () => {
    const r = checkDraftClaims({
      draft: BAD_WIFI_DUMP,
      guestMessage: MIA_EARLY_ONLY,
      context: { conversationHistory: PRIOR_GUEST_WIFI_WORKS, guestDisplayName: 'Mia' },
    });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'wifi_resend_after_known'));
    assert.doesNotMatch(r.revisedResponse || '', /WRONG_SSID|wrong-password|password is/i);
  });

  it('deterministic judge guard: Mia WiFi dump after knows → REVISE (not APPROVE)', () => {
    const agent = makeAgent();
    const out = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', notes: 'llm missed', issues: [] },
      {
        typeOfMessageReceived: 'WIFI_PASSWORD',
        proposedResponse: BAD_WIFI_DUMP,
        shouldReply: true,
      },
      {
        guestName: 'Mia',
        guestDisplayName: 'Mia',
        propertyName: 'Harbor View Studio',
        conversationHistory: HOST_SENT_PINELAND,
      },
      MIA_COMPLIMENT_EARLY
    );
    assert.equal(out.deterministicGuard, true);
    assert.ok(['REVISE', 'REJECT'].includes(out.verdict), `verdict=${out.verdict}`);
    assert.notEqual(out.verdict, 'APPROVE', 'must never APPROVE credential dump after guest knows wifi');
    if (out.verdict === 'REVISE') {
      assert.match(out.revisedResponse || '', /cleaning finishes|message you|4\s*pm/i);
      assert.doesNotMatch(out.revisedResponse || '', /WRONG_SSID|wrong-password|password is/i);
    }
  });

  it('explicit wifi ask + early check-in still covers both categories', () => {
    const agent = makeAgent();
    const msg = 'What is the wifi password? Also can we check in early?';
    const ctx = { ...miaCtxBase, conversationHistory: [] };
    assert.equal(agent._isWifiPasswordAsk(msg), true);
    assert.equal(agent._isEarlyCheckinAsk(msg), true);
    assert.equal(agent._guestAlreadyKnowsWifiFromConversation(msg, ctx), false);
    const multi = agent._applyWifiEarlyCheckinMultiIntentPolicy(
      { typeOfMessageReceived: 'OTHER_MESSAGE', proposedResponse: 'none', shouldReply: false },
      ctx,
      msg
    );
    if (multi.applied) {
      const cats = catsOf(multi);
      assert.ok(
        cats.some((c) => String(c).includes('EARLY_CHECKIN')),
        `explicit ask+early should keep EARLY_CHECKIN, got ${JSON.stringify(cats)}`
      );
    }
  });
});
