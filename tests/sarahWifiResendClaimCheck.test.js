import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDraftClaims } from '../src/harness/claimCheck.js';
import { GuestMessagingAgent } from '../src/agent.js';
import { setHostContactsForTests, TEST_HOST_CONTACTS } from '../src/config/hostContacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');
setHostContactsForTests(TEST_HOST_CONTACTS);

const SARAH_MSG =
  'Wonderful! I love your WiFi password! :) Any chance we can check-in earlier? We will be in Portland, as we arrive on the 19th and will stay at a hotel the first night. Thank you! Sara';

const BAD_ANSIA =
  "You're welcome, Sara! The WiFi network is WRONG_SSID and the password is wrong-password (all lowercase). Let me know if it works.";

const BAD_PINELAND =
  "You're welcome! The WiFi network is Pineland and the password is lobsterbake. Let me know if it works.";

const HISTORY = [
  {
    sender_type: 'host',
    body: 'The Wifi network is Pineland and the password is lobsterbake. I hope that you will feel like home at my place! Warm regards, Jerome & Ruby',
  },
];

describe('claimCheck: Sarah WiFi re-send after known (judge common sense)', () => {
  it('forces early-checkin classic when non-canonical dump follows compliment + early ask', () => {
    const r = checkDraftClaims({
      draft: BAD_ANSIA,
      guestMessage: SARAH_MSG,
      context: { conversationHistory: HISTORY, guestDisplayName: 'Sara' },
    });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'wifi_resend_after_known'));
    assert.match(r.revisedResponse || '', /cleaning finishes|message you right away|can'?t guarantee early/i);
    assert.doesNotMatch(r.revisedResponse || '', /WRONG_SSID|wrong-password|pineland|lobsterbake/i);
  });

  it('strips even correct Pineland dump when host already sent it + guest complimented', () => {
    const r = checkDraftClaims({
      draft: BAD_PINELAND,
      guestMessage: SARAH_MSG,
      context: { conversationHistory: HISTORY, guestDisplayName: 'Sara' },
    });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'wifi_resend_after_known'));
    assert.doesNotMatch(r.revisedResponse || '', /pineland|lobsterbake|password is/i);
  });

  it('does not trip when guest explicitly asks for the password', () => {
    const r = checkDraftClaims({
      draft: BAD_PINELAND,
      guestMessage: 'What is the wifi password?',
      context: { conversationHistory: HISTORY },
    });
    assert.equal(
      r.issues.some((i) => i.code === 'wifi_resend_after_known'),
      false,
      'explicit password ask must not trip wifi_resend_after_known'
    );
  });
});

describe('deterministic judge guard: Sarah WiFi re-send', () => {
  it('REVISE/REJECT non-canonical dump that LLM APPROVEd → early-checkin classic, zero credentials', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const out = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', notes: 'llm missed', issues: [] },
      {
        typeOfMessageReceived: 'WIFI_PASSWORD',
        proposedResponse: BAD_ANSIA,
        shouldReply: true,
      },
      {
        guestName: 'Sara',
        guestDisplayName: 'Sara',
        listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
        propertyName: '53 Pine St #3 · Cozy West End Victorian',
        conversationHistory: HISTORY,
      },
      SARAH_MSG
    );
    assert.equal(out.deterministicGuard, true);
    assert.ok(['REVISE', 'REJECT'].includes(out.verdict), `verdict=${out.verdict}`);
    if (out.verdict === 'REVISE') {
      assert.match(out.revisedResponse || '', /cleaning finishes|message you/i);
      assert.doesNotMatch(out.revisedResponse || '', /WRONG_SSID|wrong-password|pineland|lobsterbake|password is/i);
    }
  });
});
