#!/usr/bin/env node
/**
 * Live integration test: verify inquiry message history fetch works against Hospitable.
 *
 * Uses GET /v2/inquiries/{inquiryUuid}?include=messages (not /conversations/{id}/messages).
 *
 * Usage:
 *   node scripts/test-inquiry-history-fetch.js
 *   node scripts/test-inquiry-history-fetch.js --inquiry <uuid>
 *
 * Requires HOSPITABLE_BEARER_TOKEN in env or AWS creds for SSM /hospitable/bearer-token.
 */

import { HospitableClient } from '../src/clients/HospitableClient.js';
import { ConversationContextTool } from '../src/tools/conversation/ConversationContextTool.js';

const DEFAULT_INQUIRY = '9b00a88f-03ca-4aa8-b6cc-2c3475f35184'; // Jun 2026 alarm incident

async function main() {
  const inquiryArg = process.argv.find(a => a.startsWith('--inquiry='))?.split('=')[1]
    || (process.argv.includes('--inquiry') ? process.argv[process.argv.indexOf('--inquiry') + 1] : null)
    || DEFAULT_INQUIRY;

  const client = new HospitableClient();
  const tool = new ConversationContextTool({ hospitableClient: client });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 LIVE INQUIRY HISTORY FETCH TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`Inquiry ID: ${inquiryArg}\n`);

  console.log('→ getInquiryDetails...');
  const inquiry = await client.getInquiryDetails(inquiryArg);
  console.log(`   status: ${inquiry?.status || '(unknown)'}`);
  console.log(`   property: ${inquiry?.properties?.[0]?.name || '(none)'}\n`);

  console.log('→ Direct getInquiryMessages (new endpoint)...');
  const inquiryMsgs = await client.getInquiryMessages(inquiryArg, 10);
  console.log(`   ${inquiryMsgs.length} message(s) via /inquiries/{id}?include=messages`);

  console.log('\n→ Legacy getConversationMessages (should 404 for inquiry UUID)...');
  try {
    await client.getConversationMessages(inquiryArg, 3);
    console.log('   (unexpected) /conversations/{id}/messages succeeded');
  } catch (e) {
    console.log(`   /conversations/{id}/messages fails as expected: ${e.message.split('\n')[0]}`);
  }

  console.log('\n→ Direct GET /inquiries/{id}/messages (send-only endpoint, should 405)...');
  try {
    const token = await client.getToken();
    const axios = (await import('axios')).default;
    await axios.get(`https://public.api.hospitable.com/v2/inquiries/${inquiryArg}/messages`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    console.log('   (unexpected) GET /inquiries/{id}/messages succeeded');
  } catch (e) {
    console.log(`   GET /inquiries/{id}/messages fails as expected: ${e.response?.status || e.message}`);
  }

  console.log('\n→ ConversationContextTool.execute (requireLiveConversationHistory=true)...');
  const result = await tool.execute('Hello are you able to accommodate this reservation thanks', {
    conversation_id: inquiryArg,
    requireLiveConversationHistory: true,
  });

  console.log(`   historySource: ${result.historySource}`);
  console.log(`   recentMessageCount: ${result.recentMessageCount}`);
  console.log(`   lastHostMessagePreview: ${result.lastHostMessagePreview || '(none)'}`);

  if (result.historySource !== 'live_fetched') {
    console.error('\n❌ FAIL: expected live_fetched');
    process.exit(1);
  }

  console.log('\n✅ PASS: live inquiry history fetch works via /inquiries/{id}?include=messages');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});