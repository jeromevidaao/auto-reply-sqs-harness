#!/usr/bin/env node
/**
 * Very lightweight eval runner for v0.1.
 * In later iterations this will become much more sophisticated.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.join(__dirname, 'scenarios');
const goldensDir = path.join(__dirname, 'goldens');

async function loadJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

async function main() {
  console.log('🧪 Running auto-reply-sqs-harness evaluation suite\n');

  const agent = new GuestMessagingAgent({
    llm: 'mock',
    projectRoot: path.resolve(__dirname, '..')
  }); // force mock for deterministic evals
  const files = await fs.readdir(scenariosDir);

  let passed = 0;
  let failed = 0;

  for (const file of files.filter(f => f.endsWith('.json'))) {
    const scenarioPath = path.join(scenariosDir, file);
    const scenario = await loadJson(scenarioPath);
    const goldenPath = path.join(goldensDir, file.replace('.json', '.md'));

    console.log(`→ ${scenario.id || file}`);

    const result = await agent.processMessage(scenario.guestMessage, scenario.context);

    // Very basic heuristic check for v0.1
    const looksGood = result.shouldReply === true &&
                      result.proposedResponse &&
                      result.proposedResponse.length > 20 &&
                      !result.proposedResponse.toLowerCase().includes('$30'); // shouldn't mention pet fee

    if (looksGood) {
      console.log(`   ✅ PASS — ${result.typeOfMessageReceived}`);
      passed++;
    } else {
      console.log(`   ❌ FAIL`);
      console.log(`      Type: ${result.typeOfMessageReceived}`);
      console.log(`      Reply: ${result.proposedResponse?.slice(0, 120)}...`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
