#!/usr/bin/env node
/**
 * Local interactive simulator for the guest messaging agent.
 * Fully runnable with or without a Grok API key.
 *
 * Usage:
 *   npm run simulate
 *   node simulator/cli.js
 */

import readline from 'node:readline';
import { GuestMessagingAgent } from '../src/agent.js';
import { createLLMAdapter } from '../src/adapters/llm/index.js';

async function main() {
  const args = process.argv.slice(2);
  const llmPref = 'auto';

  if (args.includes('--llm=mock')) {
    console.error('❌ --llm=mock is no longer supported. Mock LLM has been removed.');
    process.exit(1);
  }

  console.log('🧠 Guest Messaging Agent — Local Simulator');
  console.log('   LLM adapter: auto (real Grok)');
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
