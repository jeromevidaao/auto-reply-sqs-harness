#!/usr/bin/env node
/**
 * Send the actual reply to Valentina Booker's thread using the real Hospitable API.
 *
 * Uses the production token from SSM (same as the Lambda) or HOSPITABLE_BEARER_TOKEN env var.
 *
 * Reply text: "You're welcome! If you have any other questions before or during your stay, just let us know. Safe travels!"
 */

import axios from 'axios';
import { execSync } from 'child_process';

const CONVERSATION_ID = '54a01055-447d-4461-bfe8-5efc76d5dcb2';
const REPLY_TEXT = "You're welcome! If you have any other questions before or during your stay, just let us know. Safe travels!";

function getToken() {
  if (process.env.HOSPITABLE_BEARER_TOKEN) {
    console.log('Using HOSPITABLE_BEARER_TOKEN from environment');
    return process.env.HOSPITABLE_BEARER_TOKEN;
  }

  console.log('Fetching token via AWS CLI from SSM /hospitable/bearer-token ...');
  const token = execSync(
    'aws ssm get-parameter --name /hospitable/bearer-token --with-decryption --query Parameter.Value --output text',
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
  ).trim();

  return token;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📤 SENDING REPLY TO VALENTINA BOOKER');
  console.log('   Thread: https://my.hospitable.com/inbox/thread/54a01055-447d-4461-bfe8-5efc76d5dcb2');
  console.log('   Message:', REPLY_TEXT);
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    const token = await getToken();

    const url = `https://public.api.hospitable.com/v2/conversations/${CONVERSATION_ID}/messages`;

    const response = await axios.post(url, { body: REPLY_TEXT }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      timeout: 15000
    });

    console.log('✅ SEND SUCCESSFUL');
    console.log('   Status:', response.status);
    console.log('   Response:', JSON.stringify(response.data, null, 2));

    // Verify it landed
    console.log('\n🔍 Verifying the message landed...');
    const verify = await axios.get(url + '?limit=5', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });

    const latest = verify.data?.data?.[0];
    if (latest && latest.body && latest.body.includes('welcome')) {
      console.log('✅ VERIFICATION: Reply is now the most recent message in the thread.');
    } else {
      console.log('⚠️  Verification: Could not confirm in latest messages (may need a short delay).');
    }

  } catch (err) {
    console.error('❌ SEND FAILED');
    if (err.response) {
      console.error('   Status:', err.response.status);
      console.error('   Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('   Error:', err.message);
    }

    console.log('\n--- How to send manually right now ---');
    console.log('1. In your browser (while logged into Hospitable), open DevTools → Network → any API call.');
    console.log('2. Copy the Authorization: Bearer ... header value.');
    console.log('3. Run this command with the token:');
    console.log(`   HOSPITABLE_BEARER_TOKEN="paste-token-here" node scripts/send-valentina-reply.js`);
    console.log('');
    console.log('Or generate a fresh Personal Access Token in Hospitable with write access and use it the same way.');
  }
}

main();