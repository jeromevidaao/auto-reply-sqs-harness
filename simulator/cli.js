#!/usr/bin/env node
/**
 * Local interactive simulator for the guest messaging agent.
 * Fully runnable with or without a Grok API key.
 *
 * Usage:
 *   npm run simulate
 *   node simulator/cli.js --llm=mock
 */

import readline from 'node:readline';
import { GuestMessagingAgent } from '../src/agent.js';
import { createLLMAdapter } from '../src/adapters/llm/index.js';

async function main() {
  const args = process.argv.slice(2);
  const llmPref = args.includes('--llm=mock') ? 'mock' : 'auto';

  console.log('🧠 Guest Messaging Agent — Local Simulator');
  console.log(`   LLM adapter: ${llmPref === 'mock' ? 'mock (deterministic)' : 'auto (real Grok if key present)'}`);
  console.log('   Type "exit" or "quit" to leave.\n');

  const llm = createLLMAdapter(llmPref);
  const agent = new GuestMessagingAgent({
    llmAdapter: llm,
    projectRoot: process.cwd()
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Guest> '
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (['exit', 'quit', 'q'].includes(input.toLowerCase())) {
      console.log('👋 Bye!');
      rl.close();
      return;
    }

    try {
      const result = await agent.handleMessage(input, {
        guestName: 'Test Guest',
        // You can manually extend context here while testing
      });

      console.log('\nAgent →');
      console.log(`  Category : ${result.typeOfMessageReceived}`);
      console.log(`  Reply    : ${result.proposedResponse}`);
      console.log(`  Should send: ${result.shouldReply} (confidence ${result.confidence})`);

      if (result.escalated) {
        console.log('  📨 Escalation triggered (see details above)\n');
      } else {
        console.log('');
      }
    } catch (err) {
      console.error('Error:', err.message);
    }

    rl.prompt();
  });
}

main();
