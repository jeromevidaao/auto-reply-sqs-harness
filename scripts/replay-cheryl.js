#!/usr/bin/env node
/**
 * Replay Cheryl's exact production message (history fetch failed, should have auto-replied).
 * Runs full handleMessage pipeline locally, then optionally sends via Hospitable if --send flag.
 */

import { GuestMessagingAgent } from '../src/agent.js';
import { createLLMAdapter } from '../src/adapters/llm/index.js';
import { HospitableClient } from '../src/clients/HospitableClient.js';

const GUEST_MESSAGE = `Hello Ruby and Jerome,

I am visiting with my young adult daughter and her friend. It will be my first time (not theirs) in Portland. I chose this place because we can walk to everything.

Thank you,
Cheryl`;

const CONTEXT = {
  guestName: 'Cheryl',
  reservationId: '390bc10a-7b33-484e-b3a0-f23241e3c158',
  reservation_id: '390bc10a-7b33-484e-b3a0-f23241e3c158',
  conversation_id: '5b0e6d0f-1e06-45a6-8468-78386699efca',
  checkIn: '2026-07-17T16:00:00-04:00',
  checkOut: '2026-07-19T10:00:00-04:00',
  listingId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
  propertyName: 'Downtown Studio, Walk Everywhere, Parking',
  sender_type: 'guest',
  asOfDate: '2026-06-17',
  bookingTimestamp: '2026-06-17T10:00:00Z',
  hasPets: false,
  petCount: 0,
};

async function main() {
  const shouldSend = process.argv.includes('--send');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 Cheryl replay — NEW_RESERVATION_WELCOME + history fetch failed');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const llm = createLLMAdapter('auto');
  const agent = new GuestMessagingAgent({
    llmAdapter: llm,
    enableReflection: true,
    enableConversationJudge: true,
    hospitableClient: shouldSend ? new HospitableClient() : null,
  });

  const result = await agent.handleMessage(GUEST_MESSAGE, CONTEXT);

  console.log('📊 FINAL DECISION:');
  console.log('   Category:     ', result.typeOfMessageReceived);
  console.log('   Should reply: ', result.shouldReply);
  console.log('   Escalated:    ', result.escalated);
  console.log('   Confidence:   ', result.confidence);
  console.log('');
  console.log('💬 PROPOSED REPLY:');
  console.log(result.proposedResponse);
  console.log('');

  if (!result.shouldReply || result.escalated) {
    console.error('❌ FAIL — expected shouldReply:true and escalated:false');
    process.exit(1);
  }

  const required = ['4pm', 'self-check-in', 'parking', 'Cheryl'];
  const missing = required.filter(p => !(result.proposedResponse || '').toLowerCase().includes(p.toLowerCase()));
  if (missing.length) {
    console.warn('⚠️  Missing phrases in reply:', missing.join(', '));
  }

  if (shouldSend) {
    const client = new HospitableClient();
    console.log('📤 Sending reply to reservation', CONTEXT.reservation_id);
    await client.sendMessageToReservation(CONTEXT.reservation_id, result.proposedResponse);
    console.log('✅ Message sent via Hospitable');
  } else {
    console.log('ℹ️  Dry run only. Pass --send to deliver via Hospitable.');
  }

  console.log('\n✅ Cheryl replay passed');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});