/**
 * AWS Lambda handler for the Guest Messaging Agent Harness.
 *
 * This is the production entrypoint for the harness logic.
 * It can be invoked manually for testing (no trigger attached yet).
 *
 * Expected event shape for manual testing:
 * {
 *   "message": "the guest message text",
 *   "context": {
 *     "guestName": "Josh",
 *     "checkIn": "2026-05-25",
 *     "checkOut": "2026-05-27",
 *     "listingId": "...",
 *     "propertyName": "...",
 *     "airbnb_conversation_id": "2492335251",
 *     ...
 *   }
 * }
 */

import { GuestMessagingAgent } from '../src/agent.js';

export const handler = async (event, context) => {
  console.log('Guest Messaging Harness invoked');
  console.log('Event keys:', Object.keys(event || {}));

  const agent = new GuestMessagingAgent({
    // In Lambda we prefer real providers when credentials are present
    llm: process.env.GROK_API_KEY ? 'auto' : 'mock',
    notification: 'auto', // Will use SNS if SNS_TOPIC_ARN is set, else console
  });

  const guestMessage = event?.message || event?.body || '';
  const msgContext = event?.context || event?.payload?.context || {};

  if (!guestMessage) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'No message provided in event.message or event.body' }),
    };
  }

  try {
    const result = await agent.handleMessage(guestMessage, msgContext);

    console.log('Agent decision:', {
      type: result.typeOfMessageReceived,
      shouldReply: result.shouldReply,
      escalated: result.escalated,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        decision: {
          typeOfMessageReceived: result.typeOfMessageReceived,
          proposedResponse: result.proposedResponse,
          shouldReply: result.shouldReply,
          confidence: result.confidence,
          escalated: result.escalated,
        },
        // Include full result for debugging during manual tests
        fullResult: result,
      }),
    };
  } catch (error) {
    console.error('Harness error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message,
        stack: error.stack?.split('\n').slice(0, 5),
      }),
    };
  }
};
