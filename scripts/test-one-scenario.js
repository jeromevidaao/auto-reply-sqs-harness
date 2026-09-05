#!/usr/bin/env node
/**
 * Debug runner for a single golden scenario.
 * Usage:
 *   node scripts/test-one-scenario.js apt3-lockbox-issue
 *   node scripts/test-one-scenario.js door-locking-issue --reflection
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

async function main() {
  const scenarioName = process.argv[2];
  const enableReflection = process.argv.includes('--reflection') || process.argv.includes('-r');

  if (!scenarioName) {
    console.error('Usage: node scripts/test-one-scenario.js <scenario-id> [--reflection]');
    console.error('       node scripts/test-one-scenario.js "apt3-lockbox-issue door-locking-issue josh-cleaning"');
    console.error('');
    console.error('Currently known hard failures (from latest CI):');
    console.error('  apt3-lockbox-issue, door-locking-issue, josh-cleaning, thermostat-ignore-nest-remotes,');
    console.error('  many early-checkin, cancellation, parking, welcome, pricing, self-checkin, etc.');
    process.exit(1);
  }

  const names = scenarioName.includes(' ') ? scenarioName.split(/\s+/) : [scenarioName];

  const scenarioPath = path.join(projectRoot, 'eval/scenarios', `${scenarioName}.json`);
  const goldenPath = path.join(projectRoot, 'eval/goldens', `${scenarioName}.md`);

  let scenario;
  try {
    scenario = JSON.parse(await fs.readFile(scenarioPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to load scenario: ${scenarioPath}`);
    process.exit(1);
  }

  console.log(`\n=== Testing scenario: ${scenarioName} ===`);
  console.log('Guest message:', scenario.guestMessage || scenario.message);
  console.log('Listing:', scenario.context?.propertyName || scenario.context?.listingId);
  console.log('Reflection enabled:', enableReflection);
  console.log('');

  const agent = new GuestMessagingAgent({
    llm: 'auto',
    projectRoot,
    useModularPrompt: true,
    enableReflection: true,
    enableMergedReviewer: !enableReflection,
    enableConversationJudge: true,
    requireLiveConversationHistory: false,
    reflectionCategories: [
      'CANCELLATION_POLICY',
      'CANCELLATION_NOTIFICATION',
      'CANCELLATION_POLICY_EXCEPTION',
      'NEW_RESERVATION_WELCOME',
      'NEW_INQUIRY_WELCOME',
      'GENERAL_ACKNOWLEDGMENT',
      'OTHER_MESSAGE'
    ]
  });

  const start = Date.now();
  const result = await agent.handleMessage(
    scenario.guestMessage || scenario.message,
    scenario.context || {}
  );
  const duration = Date.now() - start;

  console.log('\n=== RESULT ===');
  console.log('typeOfMessageReceived:', result.typeOfMessageReceived);
  console.log('shouldReply:', result.shouldReply);
  console.log('proposedResponse:');
  console.log(result.proposedResponse);
  console.log('\nDuration:', duration, 'ms');

  if (result.reflection) {
    console.log('\n--- Reflection ---');
    console.log(result.reflection);
  }

  if (result.conversationJudge) {
    console.log('\n--- Conversation Judge ---');
    console.log(result.conversationJudge);
  }

  // Compare against rubric if present
  const rubric = scenario.rubric || {};
  console.log('\n=== RUBRIC CHECK (local) ===');
  if (rubric.expectedCategory) {
    const expectedCats = Array.isArray(rubric.expectedCategory) ? rubric.expectedCategory : [rubric.expectedCategory];
    const receivedCats = Array.isArray(result.typeOfMessageReceived) ? result.typeOfMessageReceived : [result.typeOfMessageReceived];
    const match = expectedCats.some(ec => receivedCats.includes(ec) || result.typeOfMessageReceived === ec);
    console.log(`Category match: ${match ? '✅' : '❌'} (expected ${rubric.expectedCategory}, got ${result.typeOfMessageReceived})`);
  }
  if (rubric.shouldReply !== undefined) {
    console.log(`shouldReply match: ${result.shouldReply === rubric.shouldReply ? '✅' : '❌'}`);
  }
  if (rubric.requiredPhrases) {
    const lower = (result.proposedResponse || '').toLowerCase();
    rubric.requiredPhrases.forEach(p => {
      const has = lower.includes(p.toLowerCase());
      console.log(`Required "${p}": ${has ? '✅' : '❌'}`);
    });
  }
  if (rubric.forbiddenPhrases) {
    const lower = (result.proposedResponse || '').toLowerCase();
    rubric.forbiddenPhrases.forEach(p => {
      const has = lower.includes(p.toLowerCase());
      console.log(`Forbidden "${p}": ${has ? '❌ FOUND (bad)' : '✅ absent'}`);
    });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
