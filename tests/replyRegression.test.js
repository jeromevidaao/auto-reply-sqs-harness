import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMessagingAgent } from '../src/agent.js';

const REGRESSION_MESSAGE = 'Sounds great! Thank you! And what is the latest time we are able to check out Monday?';

test('Grok API regression: monday checkout message always generates reply', async (t) => {
  const grokKey = process.env.GROK_API_KEY;
  if (!grokKey) {
    t.skip('Skipping real Grok API call - GROK_API_KEY not set');
    return;
  }

  const agent = new GuestMessagingAgent({
    grokApiKey: grokKey,
    useRealLLM: true
  });

  const result = await agent.handleMessage({
    guestMessage: REGRESSION_MESSAGE,
    context: {
      guestName: 'TestGuest',
      checkIn: '2026-08-17',
      checkOut: '2026-08-18',
      listingId: 'test-listing-monday',
      propertyName: 'Test Apt',
      conversationHistory: []
    }
  });

  assert.equal(result.shouldReply, true, 'Must always reply for checkout time question (regression case)');
  assert.ok(result.proposedResponse, 'A reply must be generated');
  assert.notEqual(result.proposedResponse, 'none', 'proposedResponse must not be "none"');
  assert.ok(result.confidence >= 0.9, 'High confidence required for this always-reply case');
  assert.ok(
    result.proposedResponse.toLowerCase().includes('10am') ||
    result.proposedResponse.toLowerCase().includes('10 am') ||
    result.proposedResponse.toLowerCase().includes('checkout is strictly'),
    'Reply should address checkout time'
  );
});
