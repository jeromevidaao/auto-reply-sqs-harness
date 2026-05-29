#!/usr/bin/env node
/**
 * Simple standalone tool to dump messages from a Hospitable conversation thread.
 *
 * Usage (on a machine where you can get a token):
 *   HOSPITABLE_BEARER_TOKEN=xxx node scripts/dump-thread.js 54a01055-447d-4461-bfe8-5efc76d5dcb2
 *
 * Or export the token first.
 *
 * This bypasses the full HospitableClient class (and its SSM dependency)
 * so it can run in a normal local dev environment.
 */

import axios from 'axios';

const token = process.env.HOSPITABLE_BEARER_TOKEN;
const conversationId = process.argv[2] || '54a01055-447d-4461-bfe8-5efc76d5dcb2';

if (!token) {
  console.error('ERROR: Set HOSPITABLE_BEARER_TOKEN in the environment.');
  console.error('Example: HOSPITABLE_BEARER_TOKEN=your_token node scripts/dump-thread.js ' + conversationId);
  process.exit(1);
}

const baseUrl = 'https://public.api.hospitable.com/v2';

async function main() {
  console.log(`Fetching last 30 messages for conversation ${conversationId}...\n`);

  try {
    const response = await axios.get(`${baseUrl}/conversations/${conversationId}/messages`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      params: { limit: 30 },
      timeout: 15000
    });

    const messages = response.data?.data || [];

    if (messages.length === 0) {
      console.log('No messages returned. Thread might be empty or token invalid/scope limited.');
      return;
    }

    console.log(`Found ${messages.length} messages (newest first):\n`);

    messages.slice().reverse().forEach((m, idx) => {
      const time = m.created_at || m.sent_at || '';
      const who = m.sender_type || m.sender?.type || 'unknown';
      const name = m.user?.first_name || m.sender?.first_name || '';
      const body = (m.body || '').replace(/\n/g, ' ').substring(0, 120);

      console.log(`${idx + 1}. [${time}] ${who.toUpperCase()} ${name ? '(' + name + ')' : ''}`);
      console.log(`   ${body}${body.length === 120 ? '...' : ''}`);
      console.log('');
    });

    // Show the most recent few with full detail for the critical period
    console.log('\n--- Most recent messages (raw) ---');
    messages.slice(0, 8).forEach(m => {
      console.log(JSON.stringify({
        created_at: m.created_at,
        sender_type: m.sender_type,
        sender_name: m.user?.first_name || m.sender?.first_name,
        body: m.body
      }, null, 2));
      console.log('---');
    });

  } catch (err) {
    console.error('Fetch failed:', err.response?.status, err.response?.data || err.message);
    if (err.response?.status === 401) {
      console.error('Token is invalid or expired.');
    }
  }
}

main();