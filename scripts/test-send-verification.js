#!/usr/bin/env node
/**
 * Local test: Send a real message via HospitableClient and verify it appears
 * using the exact same verification logic as the Lambda handler.
 *
 * This directly tests the fix for the "send succeeded but verification 404" problem.
 *
 * Usage:
 *   HOSPITABLE_BEARER_TOKEN=xxx node scripts/test-send-verification.js
 *   HOSPITABLE_BEARER_TOKEN=xxx node scripts/test-send-verification.js --reservation <id>
 *
 * Safety:
 * - Prints the exact message and target before sending.
 * - Uses a unique message containing a timestamp + random id.
 */

import { HospitableClient } from '../src/clients/HospitableClient.js';

const client = new HospitableClient();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateUniqueMessage() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return `TEST VERIFICATION MESSAGE [${id}] - Please ignore.`;
}

async function main() {
  const args = process.argv.slice(2);
  const reservationArg = args.find(a => a.startsWith('--reservation='))?.split('=')[1];
  const conversationArg = args.find(a => a.startsWith('--conversation='))?.split('=')[1];

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 LOCAL SEND + VERIFICATION TEST');
  console.log('   Using current HospitableClient + handler-style verification (3s sleep)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (!process.env.HOSPITABLE_BEARER_TOKEN) {
    console.error('❌ HOSPITABLE_BEARER_TOKEN environment variable is required.');
    console.error('   Example: HOSPITABLE_BEARER_TOKEN=xxx node scripts/test-send-verification.js');
    process.exit(1);
  }

  try {
    let targetType, targetId, verifyConvId;

    if (reservationArg) {
      targetType = 'reservation';
      targetId = reservationArg;
      console.log(`Using provided reservation: ${targetId}`);
      try {
        verifyConvId = await client.getConversationIdForReservation(targetId);
      } catch (e) {
        console.error('Failed to resolve conversation_id from reservation:', e.message);
        process.exit(1);
      }
    } else if (conversationArg) {
      targetType = 'conversation';
      targetId = conversationArg;
      verifyConvId = conversationArg;
      console.log(`Using provided conversation: ${targetId}`);
    } else {
      // Auto-discover a recent reservation
      console.log('No target provided — fetching recent reservations to pick one for testing...\n');
      const reservations = await client.getReservations({ limit: 5 });

      if (!reservations.length) {
        console.error('No recent reservations found. Provide --reservation or --conversation.');
        process.exit(1);
      }

      const chosen = reservations[0];
      targetType = 'reservation';
      targetId = chosen.id;
      console.log(`Auto-selected recent reservation: ${targetId} (guest: ${chosen.guest?.first_name || 'unknown'})`);

      try {
        verifyConvId = await client.getConversationIdForReservation(targetId);
      } catch (e) {
        console.error('Failed to resolve conversation_id:', e.message);
        process.exit(1);
      }
    }

    if (!verifyConvId) {
      console.error('Could not determine a conversation ID for verification.');
      process.exit(1);
    }

    const testMessage = generateUniqueMessage();
    const preview = testMessage.substring(0, 60) + '...';

    console.log('\n📤 About to send test message:');
    console.log(`   Target: ${targetType} ${targetId}`);
    console.log(`   Message: ${testMessage}`);
    console.log(`   Verification conv ID: ${verifyConvId}\n`);

    if (!args.includes('--confirm')) {
      console.log('⚠️  This will send a real message to a guest conversation.');
      console.log('   Re-run with --confirm to actually send.');
      process.exit(0);
    }

    // === SEND ===
    console.log('→ Sending...');
    if (targetType === 'reservation') {
      await client.sendMessageToReservation(targetId, testMessage);
    } else {
      await client.sendMessage(targetId, testMessage);
    }
    console.log('✅ Send API call succeeded');

    // === VERIFICATION (exact logic from current handler) ===
    console.log('\n⏳ Waiting 3 seconds (matching handler logic)...');
    await sleep(3000);

    console.log('🔍 Fetching recent messages for verification...');
    const recentMessages = targetType === 'reservation'
      ? await client.getReservationMessages(targetId, 8)
      : await client.getConversationMessages(verifyConvId, 8);
    const found = recentMessages.some(m => m.body && m.body.includes(testMessage));

    console.log('\n═══════════════════════════════════════════════════════════════');
    if (found) {
      console.log('✅ VERIFICATION SUCCESSFUL');
      console.log('   The exact test message was found in recent conversation messages.');
      console.log('   The current send + verification logic works correctly.');
    } else {
      console.log('⚠️  VERIFICATION DID NOT FIND THE MESSAGE');
      console.log('   This is the exact failure mode seen in production logs.');
      console.log('   Recent messages preview:');
      recentMessages.slice(0, 5).forEach((m, i) => {
        console.log(`   [${i}] ${m.sender_type}: ${(m.body || '').substring(0, 80)}`);
      });
    }
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n❌ Test failed with error:');
    console.error(err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    process.exit(1);
  }
}

main();