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

const JANE_TV_WIFI =
  'Hi Jerome! We have very much enjoyed our time here so far! We are having some issues with the tv connecting to the wifi. Are there any specific steps needed to connect?';

const janeCtx = {
  guestName: 'Jane',
  checkIn: '2026-09-12',
  checkOut: '2026-09-16',
  asOfDate: '2026-09-13',
  listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
  propertyName: '53 Pine St #2 · 1875 West End Victorian | EV Charging + Parking',
};

describe('Jane TV WiFi connect (West End Victorian production miss)', () => {
  it('detects TV/device WiFi connect trouble (Jane wording)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._isWifiDeviceConnectAsk(JANE_TV_WIFI), true);
    assert.equal(agent._isWifiPasswordAsk(JANE_TV_WIFI), false);
    assert.equal(agent._isWifiDeviceConnectAsk('What is the wifi password?'), false);
    assert.equal(agent._isWifiPasswordAsk('What is the wifi password?'), true);
    assert.equal(agent._isWifiDeviceConnectAsk('The wifi is great, thanks!'), false);
  });

  it('forces WIFI_TROUBLESHOOTING + credentials + steps when LLM withholds (Jane TV miss)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyWifiPolicy(
      {
        typeOfMessageReceived: 'OTHER_MESSAGE',
        proposedResponse: 'none',
        shouldReply: false,
      },
      janeCtx,
      JANE_TV_WIFI
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'WIFI_TROUBLESHOOTING');
    assert.match(applied.proposedResponse, new RegExp(TEST_HOST_CONTACTS.wifiSsid, 'i'));
    assert.match(applied.proposedResponse, new RegExp(TEST_HOST_CONTACTS.wifiPassword, 'i'));
    assert.match(applied.proposedResponse, /settings/i);
    assert.match(applied.proposedResponse, /let me know if it works/i);
    assert.doesNotMatch(applied.proposedResponse, /Pineland|lobsterbake/i);
  });

  it('forces WIFI_PASSWORD credentials on explicit password ask', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyWifiPolicy(
      {
        typeOfMessageReceived: 'OTHER_MESSAGE',
        proposedResponse: 'none',
        shouldReply: false,
      },
      { guestName: 'Sam' },
      'What is the wifi password?'
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'WIFI_PASSWORD');
    assert.match(applied.proposedResponse, new RegExp(TEST_HOST_CONTACTS.wifiSsid, 'i'));
    assert.match(applied.proposedResponse, new RegExp(TEST_HOST_CONTACTS.wifiPassword, 'i'));
  });

  it('does not rewrite a draft that already has credentials + steps + let me know', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const good =
      `Hi Jane, please check the WiFi settings on the TV and connect to ${TEST_HOST_CONTACTS.wifiSsid} / ${TEST_HOST_CONTACTS.wifiPassword}. Let me know if it works.`;
    const applied = agent._applyWifiPolicy(
      {
        typeOfMessageReceived: 'WIFI_TROUBLESHOOTING',
        proposedResponse: good,
        shouldReply: true,
      },
      janeCtx,
      JANE_TV_WIFI
    );
    assert.equal(applied.applied, false);
  });

  it('processMessage auto-replies Jane TV WiFi even when LLM says no-reply', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'OTHER_MESSAGE',
            proposedResponse: 'none',
            shouldReply: false,
            confidence: 0.4,
          }),
      },
    });
    const result = await agent.processMessage(JANE_TV_WIFI, janeCtx);
    assert.equal(result.shouldReply, true);
    assert.equal(result.typeOfMessageReceived, 'WIFI_TROUBLESHOOTING');
    assert.match(result.proposedResponse, new RegExp(TEST_HOST_CONTACTS.wifiSsid, 'i'));
    assert.match(result.proposedResponse, new RegExp(TEST_HOST_CONTACTS.wifiPassword, 'i'));
    assert.match(result.proposedResponse, /let me know if it works/i);
    assert.match(result.proposedResponse, /settings/i);
  });
});
