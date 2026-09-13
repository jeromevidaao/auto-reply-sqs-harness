import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { setHostContactsForTests, TEST_HOST_CONTACTS, clearHostContactsCache } from '../src/config/hostContacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

setHostContactsForTests(TEST_HOST_CONTACTS);
process.env.ALLOW_HOST_CONTACT_TEST_DEFAULTS = '1';

/**
 * Julia Downtown Studio 2026-09-13: guest asked checkout time with no thank-you,
 * SQS auto-reply opened with "You're welcome!" — false gratitude.
 * Mock Hospitable send path; do not mock the gratitude / checkout post-policies.
 */
describe('false Youre welcome without thank-you (Julia checkout)', () => {
  const juliaMsg =
    'Hi Jerome!! Excited for our trip this weekend. What time is checkout on Sunday?';

  it('checkout policy: no thank-you → draft must not say Youre welcome', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    // Simulate what Grok produced in production (false opener).
    const applied = agent._applyLatestCheckoutTimePolicy(
      {
        typeOfMessageReceived: 'CHECKOUT',
        proposedResponse: "You're welcome! Checkout is strictly at 10am.",
        shouldReply: true,
        confidence: 1.0,
      },
      { guestName: 'Julia', propertyName: 'Downtown Studio' },
      juliaMsg
    );
    assert.equal(applied.applied, true, 'checkout-time policy must apply to Julia wording');
    assert.match(applied.proposedResponse, /checkout is strictly at 10am/i);
    assert.doesNotMatch(
      applied.proposedResponse,
      /you(?:'|’)re welcome|you are welcome/i,
      'must not invent Youre welcome when guest never thanked'
    );
  });

  it('processMessage: Grok-like draft with Youre welcome is stripped when no thanks (Hospitable mocked)', async () => {
    const sent = [];
    const hospitableClient = {
      // Mock Hospitable — never hit the network
      getReservation: async () => null,
      getConversationMessages: async () => [],
      sendMessage: async (payload) => {
        sent.push(payload);
        return { ok: true };
      },
    };

    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      hospitableClient,
      // Return the exact bad production-shaped draft (do not mock gratitude helpers).
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'CHECKOUT',
            proposedResponse: "You're welcome! Checkout is strictly at 10am.",
            shouldReply: true,
            confidence: 1.0,
            reason: 'checkout time',
          }),
      },
    });

    const out = await agent.processMessage(juliaMsg, {
      guestName: 'Julia',
      propertyName: 'Downtown Studio',
      checkIn: '2026-09-17',
      checkOut: '2026-09-20',
      conversationHistory: [
        {
          role: 'host',
          content:
            '…self-check-in, and you have one dedicated off-street parking spot. I will send the detailed check-in instructions 3 days before your arrival. Looking forward to hosting you in Portland. Jerome & Ruby.',
        },
        { role: 'guest', content: 'Can’t wait!!!' },
        { role: 'host', content: "You're welcome, Julia!" },
      ],
      requireLiveConversationHistory: false,
    });

    assert.equal(out.shouldReply, true);
    assert.match(String(out.proposedResponse), /checkout is strictly at 10am/i);
    assert.doesNotMatch(
      String(out.proposedResponse),
      /you(?:'|’)re welcome|you are welcome/i,
      'final draft must not open with false Youre welcome'
    );
  });

  it('with thank-you, Youre welcome opener remains allowed', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const msg =
      'Sounds great! Thank you! And what is the latest time we are able to check out Monday?';
    const applied = agent._applyLatestCheckoutTimePolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: 'none',
        shouldReply: false,
        confidence: 0.4,
      },
      { guestName: 'Guest' },
      msg
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /you(?:'|’)re welcome/i);
    assert.match(applied.proposedResponse, /checkout is strictly at 10am/i);
  });
});
