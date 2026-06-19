#!/usr/bin/env node
/**
 * Live integration test: verify conversation history fetch works against Hospitable.
 *
 * Usage:
 *   node scripts/test-conversation-history-fetch.js
 *   node scripts/test-conversation-history-fetch.js --reservation <uuid>
 *
 * Requires HOSPITABLE_BEARER_TOKEN in env or AWS creds for SSM /hospitable/bearer-token.
 */

import { HospitableClient } from '../src/clients/HospitableClient.js';
import { ConversationContextTool } from '../src/tools/conversation/ConversationContextTool.js';

const DEFAULT_RESERVATION = '17e9d5b0-3493-4dc0-b218-0c81677551c1'; // Rene (known welcome + thank-you thread)

async function main() {
  const reservationArg = process.argv.find(a => a.startsWith('--reservation='))?.split('=')[1]
    || (process.argv.includes('--reservation') ? process.argv[process.argv.indexOf('--reservation') + 1] : null)
    || DEFAULT_RESERVATION;

  const client = new HospitableClient();
  const tool = new ConversationContextTool({ hospitableClient: client });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 LIVE CONVERSATION HISTORY FETCH TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const reservation = await client.getReservation(reservationArg);
  const conversationId = reservation?.conversation_id || await client.getConversationIdForReservation(reservationArg);

  console.log(`Reservation: ${reservationArg}`);
  console.log(`Guest: ${reservation?.guest?.first_name || reservation?.guest?.full_name || 'unknown'}`);
  console.log(`conversation_id: ${conversationId || '(none)'}\n`);

  console.log('→ Direct getReservationMessages...');
  const directMsgs = await client.getReservationMessages(reservationArg, 10);
  console.log(`   ${directMsgs.length} message(s) via /reservations/{id}/messages`);

  if (conversationId) {
    try {
      await client.getConversationMessages(conversationId, 3);
      console.log('   (unexpected) /conversations/{id}/messages succeeded');
    } catch (e) {
      console.log(`   /conversations/{id}/messages still fails as expected: ${e.message.split('\n')[0]}`);
    }
  }

  console.log('\n→ ConversationContextTool.execute (requireLiveConversationHistory=true)...');
  const result = await tool.execute('Thank you so much!', {
    reservationId: reservationArg,
    conversation_id: conversationId,
    requireLiveConversationHistory: true,
  });

  console.log(`   historySource: ${result.historySource}`);
  console.log(`   recentMessageCount: ${result.recentMessageCount}`);
  console.log(`   recentWelcomeSent: ${result.recentWelcomeSent}`);
  console.log(`   lastHostMessagePreview: ${result.lastHostMessagePreview || '(none)'}`);

  if (result.historySource !== 'live_fetched' || result.recentMessageCount === 0) {
    console.error('\n❌ FAIL: expected live_fetched with at least one message');
    process.exit(1);
  }

  console.log('\n✅ PASS: live conversation history fetch works via reservation messages endpoint');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});