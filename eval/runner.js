#!/usr/bin/env node
/**
 * Eval runner with rubrics and prompt mode support (v0.3).
 *
 * Usage:
 *   npm run eval                    # default modular prompt
 *   npm run eval -- --mode=raw --raw-prompt=prompts/system/raw/production-current.md
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
  const args = process.argv.slice(2);
  const mode = args.find(a => a.startsWith('--mode='))?.split('=')[1] || 'modular';
  const rawPromptPath = args.find(a => a.startsWith('--raw-prompt='))?.split('=')[1];

  console.log(`🧪 Running evaluation suite (mode: ${mode})\n`);

  if (!process.env.GROK_API_KEY) {
    console.error('❌ GROK_API_KEY is required to run the evaluation suite.');
    console.error('   Mock LLM is no longer supported, even for evals.');
    process.exit(1);
  }

  const agentOptions = {
    llm: 'auto',
    projectRoot: path.resolve(__dirname, '..'),
    useModularPrompt: mode === 'modular'
  };

  if (mode === 'raw' && rawPromptPath) {
    agentOptions.fullPromptPath = rawPromptPath;
  }

  const agent = new GuestMessagingAgent(agentOptions);

  const files = await fs.readdir(scenariosDir);
  let passed = 0;
  let failed = 0;
  const results = [];

  for (const file of files.filter(f => f.endsWith('.json'))) {
    const scenarioPath = path.join(scenariosDir, file);
    const scenario = await loadJson(scenarioPath);
    const goldenPath = path.join(goldensDir, file.replace('.json', '.md'));

    console.log(`→ ${scenario.id || file}`);

    const context = {
      guestName: scenario.guestName,
      checkIn: scenario.checkIn,
      checkOut: scenario.checkOut,
      listingId: scenario.listingId,
      ...scenario.context
    };

    const result = await agent.processMessage(scenario.message || scenario.guestMessage, context);

    // Basic rubric scoring
    const rubric = scenario.rubric || {};
    let score = 0;
    let maxScore = 0;
    const notes = [];

    // Category check
    if (rubric.expectedCategory) {
      maxScore++;
      if (result.typeOfMessageReceived === rubric.expectedCategory || 
          (Array.isArray(result.typeOfMessageReceived) && result.typeOfMessageReceived.includes(rubric.expectedCategory))) {
        score++;
      } else {
        notes.push(`Expected category ${rubric.expectedCategory}, got ${result.typeOfMessageReceived}`);
      }
    }

    // Should reply
    if (rubric.shouldReply !== undefined) {
      maxScore++;
      if (result.shouldReply === rubric.shouldReply) score++;
      else notes.push(`shouldReply mismatch`);
    }

    // Must not contain forbidden phrases
    if (rubric.forbiddenPhrases) {
      maxScore++;
      const lower = (result.proposedResponse || '').toLowerCase();
      const hasForbidden = rubric.forbiddenPhrases.some(p => lower.includes(p.toLowerCase()));
      if (!hasForbidden) score++;
      else notes.push(`Contained forbidden phrase`);
    }

    // Must contain required phrases (loose check)
    if (rubric.requiredPhrases) {
      maxScore += rubric.requiredPhrases.length;
      const lower = (result.proposedResponse || '').toLowerCase();
      rubric.requiredPhrases.forEach(phrase => {
        if (lower.includes(phrase.toLowerCase())) score++;
        else notes.push(`Missing required phrase: ${phrase}`);
      });
    }

    const passedScenario = score === maxScore && maxScore > 0;

    console.log(`   ${passedScenario ? '✅' : '❌'} Score: ${score}/${maxScore} — ${result.typeOfMessageReceived}`);
    if (notes.length > 0) console.log(`      Notes: ${notes.join('; ')}`);

    if (passedScenario) {
      passed++;
    } else {
      failed++;
    }

    results.push({ id: scenario.id || file, score, maxScore, passed: passedScenario });
  }

  console.log(`\n=== Summary ===`);
  console.log(`${passed} passed, ${failed} failed`);

  const totalScore = results.reduce((a, b) => a + b.score, 0);
  const totalMax = results.reduce((a, b) => a + b.maxScore, 0);
  console.log(`Overall rubric score: ${totalScore}/${totalMax}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
