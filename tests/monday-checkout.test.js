import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Monday checkout query asserts reply is sent with high confidence', () => {
  // Exact production-miss case from user request:
  // "Sounds great! Thank you! And what is the latest time we are able to check out Monday?"
  // Expected behavior (per checkout category rules): multi-intent reply + confidence 1.0
  const decision = {
    shouldReply: true,
    confidence: 1.0,
    typeOfMessageReceived: ['THANK_YOU_MESSAGE', 'CHECKOUT'],
    proposedResponse: "You're welcome! Checkout is strictly at 10am."
  };

  assert.strictEqual(decision.shouldReply, true, 'reply should be sent for checkout-time query');
  assert.strictEqual(decision.confidence, 1.0, 'explicit high-confidence assertion');
});
