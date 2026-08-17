#!/usr/bin/env node
/**
 * Eval runner with rubrics and prompt mode support (v0.3).
 *
 * Usage:
 *   npm run eval                    # default modular prompt
 *   npm run eval -- --fail-fast
 *   npm run eval -- --only=cassidy-post-checkout-parking,late-checkout-10am-cleaning
 *   npm run eval -- --mode=raw --raw-prompt=prompts/system/raw/production-current.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import {
  setHostContactsForTests,
  TEST_HOST_CONTACTS,
} from '../src/config/hostContacts.js';

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
  const failFast = args.includes('--fail-fast');
  const onlyArg = args.find(a => a.startsWith('--only='))?.split('=')[1];
  const onlySet = onlyArg
    ? new Set(
        onlyArg
          .split(',')
          .map(s => s.trim().replace(/\.json$/, ''))
          .filter(Boolean)
      )
    : null;

  console.log(`🧪 Running evaluation suite (mode: ${mode})\n`);

  // Eval must never need production SSM. Use synthetic host contacts (555 numbers).
  process.env.ALLOW_HOST_CONTACT_TEST_DEFAULTS = '1';
  setHostContactsForTests(TEST_HOST_CONTACTS);

  let files = (await fs.readdir(scenariosDir)).filter(f => f.endsWith('.json'));
  if (onlySet) {
    const matched = files.filter(f => onlySet.has(f.replace(/\.json$/, '')) || onlySet.has(f));
    const missing = [...onlySet].filter(
      id => !matched.some(f => f.replace(/\.json$/, '') === id)
    );
    if (missing.length) {
      console.error(`Unknown --only id(s): ${missing.join(', ')}`);
      process.exit(1);
    }
    files = matched;
    console.log(`Only: ${[...onlySet].join(', ')}\n`);
  }

  if (!process.env.GROK_API_KEY) {
    console.warn('⚠️  Skipping evaluation suite: GROK_API_KEY is not set.');
    console.warn('   Real Grok is required (mock LLM has been permanently removed).');
    console.warn('   The eval will only run in environments that have the key (e.g. local dev or CI with secret).');
    process.exit(0); // Exit successfully so CI does not fail
  }

  const agentOptions = {
    llm: 'auto',
    projectRoot: path.resolve(__dirname, '..'),
    useModularPrompt: mode === 'modular',
    // Eval provides conversationHistory in scenarios; no live Hospitable fetch.
    requireLiveConversationHistory: false,
  };

  if (mode === 'raw' && rawPromptPath) {
    agentOptions.fullPromptPath = rawPromptPath;
  }

  const agent = new GuestMessagingAgent(agentOptions);

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

    // Category check (handles string or array for both expected and received, as model can return array for multi-category)
    if (rubric.expectedCategory) {
      maxScore++;
      const expectedCats = Array.isArray(rubric.expectedCategory) ? rubric.expectedCategory : [rubric.expectedCategory];
      const receivedCats = Array.isArray(result.typeOfMessageReceived) ? result.typeOfMessageReceived : [result.typeOfMessageReceived];
      const catMatch = expectedCats.some(ec => receivedCats.includes(ec) || result.typeOfMessageReceived === ec);
      if (catMatch) {
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

    // Production-miss hardening: must always auto-reply (Cassidy / capture script)
    if (rubric.shouldAlwaysReply === true || scenario.productionMiss === true) {
      maxScore++;
      const draft = (result.proposedResponse || '').trim();
      const ok =
        result.shouldReply === true &&
        draft &&
        draft !== 'none' &&
        draft.length >= 12;
      if (ok) score++;
      else {
        notes.push(
          `shouldAlwaysReply failed (shouldReply=${result.shouldReply}, draftLen=${draft.length})`
        );
      }
    }

    // Minimum confidence floor (honest unit tests / production-miss goldens)
    if (rubric.minConfidence != null && Number.isFinite(Number(rubric.minConfidence))) {
      maxScore++;
      const need = Number(rubric.minConfidence);
      const got = Number(result.confidence);
      if (Number.isFinite(got) && got + 1e-9 >= need) score++;
      else notes.push(`minConfidence failed: need >=${need}, got ${got}`);
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

    // Greeting enforcement for first-host / first-of-day cases
    if (rubric.mustStartWithGreeting) {
      maxScore++;
      const resp = (result.proposedResponse || '').trim();
      const startsWithGood = /^(Good (morning|afternoon|evening)|Hi |Hey |Hello )/i.test(resp);
      if (startsWithGood) score++;
      else notes.push('Must start with time-based greeting (Good morning/afternoon/evening ...)');
    }
    if (rubric.greetingMustUseName) {
      maxScore++;
      const resp = (result.proposedResponse || '').toLowerCase();
      const name = String(rubric.greetingMustUseName).toLowerCase();
      // Name should appear early in the response (after possible greeting)
      const nameIndex = resp.indexOf(name);
      if (nameIndex >= 0 && nameIndex < 60) score++;
      else notes.push(`Greeting must use natural guest name "${rubric.greetingMustUseName}" near the start`);
    }

    const passedScenario = score === maxScore && maxScore > 0;

    console.log(`   ${passedScenario ? '✅' : '❌'} Score: ${score}/${maxScore} — ${result.typeOfMessageReceived}`);
    if (notes.length > 0) console.log(`      Notes: ${notes.join('; ')}`);

    if (passedScenario) {
      passed++;
    } else {
      failed++;
      if (failFast) {
        console.log('\n⛔ Fail-fast: stopping after first scenario failure');
        results.push({ id: scenario.id || file, score, maxScore, passed: passedScenario });
        process.exitCode = 1;
        break;
      }
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
