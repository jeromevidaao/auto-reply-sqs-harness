import { GuestMessagingAgent } from './agent.js';

const ORIGINAL_MESSAGE = 'Sounds great! Thank you! And what is the latest time we are able to check out Monday?';

export async function sendMessageViaHarness() {
  console.log('t3_verify_reply: Triggering guest reply for checkout question');

  const agent = new GuestMessagingAgent({
    useRealLLM: !!process.env.GROK_API_KEY,
    grokApiKey: process.env.GROK_API_KEY
  });

  const result = await agent.handleMessage({
    guestMessage: ORIGINAL_MESSAGE,
    context: {
      guestName: 'Guest',
      checkIn: '2026-08-17',
      checkOut: '2026-08-18',
      listingId: 'test-listing',
      propertyName: 'Test Property',
      conversationHistory: []
    }
  });

  if (result.shouldReply && result.proposedResponse && result.proposedResponse !== 'none') {
    console.log('SUCCESS: Guest received auto-reply for the checkout question');
    console.log('Response:', result.proposedResponse);
    return result;
  } else {
    throw new Error('FAILURE: No auto-reply produced for checkout question');
  }
}

// Auto-run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  sendMessageViaHarness().catch(console.error);
}
