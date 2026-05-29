#!/usr/bin/env node
/**
 * Simple tool to fetch a Hospitable conversation thread (messages) manually.
 *
 * Usage:
 *   HOSPITABLE_BEARER_TOKEN=your_token node scripts/dump-hospitable-thread.js 54a01055-447d-4461-bfe8-5efc76d5dcb2
 *
 * This is useful when the SSM token doesn't have access, so you can use
 * a token from the Hospitable UI / app config / browser.
 */

import axios from 'axios';

const token = process.env.HOSPITABLE_BEARER_TOKEN;
const conversationId = process.argv[2] || '54a01055-447d-4461-bfe8-5efc76d5dcb2';

if (!token) {
  console.error('ERROR: Set HOSPITABLE_BEARER_TOKEN environment variable with a working token.');
  console.error('Example:');
  console.error('  HOSPITABLE_BEARER_TOKEN=xxx node scripts/dump-hospitable-thread.js ' + conversationId);
  process.exit(1);
}

const baseUrl = 'https://public.api.hospitable.com/v2';

async function main() {
  console.log(`Fetching messages for conversation: ${conversationId}\n`);

  try {
    const response = await axios.get(`${baseUrl}/conversations/${conversationId}/messages`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      params: {
        limit: 30
      },
      timeout: 15000
    });

    const messages = response.data?.data || [];

    if (messages.length === 0) {
      console.log('No messages returned.');
      return;
    }

    console.log(`Found ${messages.length} messages (most recent first):\n`);

    // Print in chronological order (reverse the array from API which is newest first)
    const chronological = [...messages].reverse();

    chronological.forEach((msg, index) => {
      const time = msg.created_at || msg.sent_at || 'unknown time';
      const sender = msg.sender_type || (msg.sender && msg.sender.type) || 'unknown';
      const name = msg.user?.first_name || (msg.sender && msg.sender.first_name) || '';
      const body = msg.body || '';

      console.log(`[${index + 1}] ${time} | ${sender.toUpperCase()} ${name ? `(${name})` : ''}`);
      console.log(body);
      console.log('---');
    });

    console.log('\nRaw data (last 5 messages):');
    messages.slice(0, 5).forEach(m => {
      console.log(JSON.stringify({
        created_at: m.created_at,
        sender_type: m.sender_type,
        body: m.body?.substring(0, 100)
      }, null, 2));
      console.log('---');
    });

  } catch (err) {
    console.error('Failed to fetch:');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

main();