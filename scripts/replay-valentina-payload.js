#!/usr/bin/env node
/**
 * Replay using the exact reconstructed real-world SQS payload for
 * Valentina Booker's "Okay perfect. Thanks so much" message.
 *
 * This payload was built from:
 *   - Fresh reservation data fetched via Hospitable API
 *   - Real webhook structure observed in production CloudWatch logs
 *   - The exact guest message text
 */

import fs from 'fs';
import { GuestMessagingAgent } from '../src/agent.js';
import { createLLMAdapter } from '../src/adapters/llm/index.js';

const payloadPath = './test-payloads/valentina-okay-perfect-sqs.json';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 LOCAL REPLAY — Real production SQS payload (Valentina Booker)');
  console.log('   File: test-payloads/valentina-okay-perfect-sqs.json');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const rawEvent = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

  // Use the same extraction logic as the Lambda handler
  function extractMessageAndContext(evt) {
    const record = evt?.Records?.[0];
    if (!record?.body) return { message: '', context: {} };

    let outer;
    try { outer = JSON.parse(record.body); } catch { return { message: record.body, context: {} }; }

    if (typeof outer.body === 'string') {
      try {
        const inner = JSON.parse(outer.body);
        if (inner?.data) {
          return {
            message: inner.data.body || '',
            context: {
              ...inner.data,
              reservationId: inner.data.reservation_id || null,
              conversation_id: inner.data.conversation_id,
              sender_type: inner.data.sender_type,
              sender: inner.data.sender,
            }
          };
        }
      } catch {}
    }
    return { message: '', context: {} };
  }

  const extracted = extractMessageAndContext(rawEvent);
  const guestMessage = extracted.message;
  const msgContext = extracted.context;

  console.log('📥 Extracted from real SQS payload:');
  console.log('   Message:', guestMessage);
  console.log('   sender_type:', msgContext.sender_type);
  console.log('   conversation_id:', msgContext.conversation_id);
  console.log('   reservation_id:', msgContext.reservationId);
  console.log('');

  // Sender guard (same as production)
  const senderType = (msgContext.sender_type || '').toLowerCase();
  if (senderType && senderType !== 'guest') {
    console.log('⛔ Guard blocked (non-guest). This matches production behavior for recent tests.');
    return;
  }

  console.log('✅ Passed sender guard\n');

  const llm = createLLMAdapter('auto');
  const agent = new GuestMessagingAgent({
    llmAdapter: llm,
    enableReflection: true,
    reflectionCategories: [
      'CANCELLATION_POLICY',
      'CANCELLATION_NOTIFICATION',
      'CANCELLATION_POLICY_EXCEPTION',
      'NEW_RESERVATION_WELCOME',
      'NEW_INQUIRY_WELCOME',
      'GENERAL_ACKNOWLEDGMENT',
      'OTHER_MESSAGE'
    ],
    enableConversationJudge: true
  });

  const result = await agent.handleMessage(guestMessage, msgContext);

  console.log('📊 Decision:');
  console.log('   Category:', result.typeOfMessageReceived);
  console.log('   shouldReply:', result.shouldReply);
  console.log('   proposedResponse:', result.proposedResponse);
  console.log('');

  if (result.shouldReply && result.proposedResponse) {
    console.log('📤 [SIMULATED] Would send to Hospitable:');
    console.log('   conversation_id:', msgContext.conversation_id);
    console.log('   body:', result.proposedResponse);
    console.log('');
    console.log('✅ Full pipeline succeeded for this real production payload.');
  }
}

main().catch(console.error);