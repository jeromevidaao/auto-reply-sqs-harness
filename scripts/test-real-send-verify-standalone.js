#!/usr/bin/env node
/**
 * Standalone test (no dependencies on internal modules except axios).
 * 
 * Sends a real message to Hospitable and verifies it appears using the
 * same pattern as the current Lambda handler (3s sleep + get recent messages).
 *
 * Usage:
 *   HOSPITABLE_BEARER_TOKEN=xxx node scripts/test-real-send-verify-standalone.js --confirm
 */

import axios from 'axios';

const BASE_URL = 'https://public.api.hospitable.com/v2';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getToken() {
  const token = process.env.HOSPITABLE_BEARER_TOKEN;
  if (!token) {
    console.error('❌ HOSPITABLE_BEARER_TOKEN is required');
    process.exit(1);
  }
  return token;
}

async function getRecentReservations(token, limit = 3) {
  const res = await axios.get(`${BASE_URL}/reservations`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    params: { limit, sort: '-arrival_date' },
    timeout: 15000,
  });
  return res.data?.data || [];
}

async function sendMessage(token, conversationId, body) {
  const url = `${BASE_URL}/conversations/${conversationId}/messages`;
  const res = await axios.post(url, { body }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 15000,
  });
  return res.data;
}

async function getRecentMessages(token, conversationId, limit = 8) {
  const url = `${BASE_URL}/conversations/${conversationId}/messages`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    params: { limit },
    timeout: 15000,
  });
  return res.data?.data || [];
}

async function main() {
  const args = process.argv.slice(2);
  const doConfirm = args.includes('--confirm');
  const conversationArg = args.find(a => a.startsWith('--conversation='))?.split('=')[1];
  const reservationArg = args.find(a => a.startsWith('--reservation='))?.split('=')[1];

  const token = getToken();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 STANDALONE SEND + VERIFICATION TEST (Real Hospitable)');
  console.log('   Sleep: 3000ms | Using current production-style verification');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let conversationId;

  if (conversationArg) {
    conversationId = conversationArg;
    console.log(`Using provided conversation: ${conversationId}`);
  } else if (reservationArg) {
    console.error('This standalone script currently only supports --conversation for direct testing.');
    process.exit(1);
  } else {
    console.log('Fetching recent reservations to pick a target...\n');
    let reservations;
    try {
      reservations = await getRecentReservations(token, 3);
    } catch (e) {
      console.error('Failed to fetch reservations:', e.response?.data || e.message);
      process.exit(1);
    }

    if (!reservations.length) {
      console.error('No recent reservations found. Please provide --conversation.');
      process.exit(1);
    }

    const target = reservations[0];
    conversationId = target.conversation_id || target.id;

    if (!conversationId) {
      console.error('Could not determine conversation_id from reservation:', target.id);
      process.exit(1);
    }
    console.log(`Auto-selected recent reservation conversation: ${conversationId}`);
  }

  const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  const testMessage = `TEST-VERIFY [${uniqueId}] - Safe to ignore.`;

  console.log('Target selected:');
  console.log(`  Conversation: ${conversationId}`);
  console.log(`  Message:      ${testMessage}\n`);

  if (!doConfirm) {
    console.log('⚠️  Dry run only. Re-run with --confirm to actually send the test message.');
    process.exit(0);
  }

  console.log('→ Sending test message...');
  try {
    await sendMessage(token, conversationId, testMessage);
    console.log('✅ Send successful');
  } catch (e) {
    console.error('❌ Send failed:', e.response?.data || e.message);
    process.exit(1);
  }

  console.log('\n⏳ Waiting 3 seconds (matching handler)...');
  await sleep(3000);

  console.log('🔍 Fetching recent messages for verification...');
  let messages;
  try {
    messages = await getRecentMessages(token, conversationId, 8);
  } catch (e) {
    console.error('❌ Failed to fetch messages for verification:', e.response?.data || e.message);
    process.exit(1);
  }

  const found = messages.some(m => (m.body || '').includes(uniqueId));

  console.log('\n═══════════════════════════════════════════════════════════════');
  if (found) {
    console.log('✅ VERIFICATION SUCCESS');
    console.log('   The exact test message was found in recent messages.');
    console.log('   Send + 3s sleep + getConversationMessages works correctly.');
  } else {
    console.log('⚠️  VERIFICATION DID NOT FIND THE MESSAGE');
    console.log('   This matches the production failure mode you saw.');
    console.log('\n   Last few messages:');
    messages.slice(0, 5).forEach((m, i) => {
      console.log(`   [${i}] ${m.sender_type}: ${(m.body || '').substring(0, 90)}`);
    });
  }
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});