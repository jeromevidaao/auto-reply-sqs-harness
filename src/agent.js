import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLLMAdapter } from './adapters/llm/index.js';
import { createNotificationAdapter } from './adapters/notification/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');

export class GuestMessagingAgent {
  constructor(options = {}) {
    this.llm = options.llmAdapter || createLLMAdapter(options.llm || 'auto');
    this.notification = options.notificationAdapter || createNotificationAdapter(options.notification || 'auto');

    // Priority: explicit option > env var > process.cwd() (normal local dev) > package root
    const root =
      options.projectRoot ||
      process.env.HARNESS_ROOT ||
      process.cwd();

    this.promptPath = options.promptPath || path.join(root, 'prompts', 'system', 'base.md');
    this.systemPrompt = null;
  }

  async loadPrompt() {
    if (this.systemPrompt) return this.systemPrompt;

    try {
      this.systemPrompt = await fs.readFile(this.promptPath, 'utf8');
    } catch (err) {
      console.error('Failed to load prompt from', this.promptPath);
      throw err;
    }
    return this.systemPrompt;
  }

  /**
   * Main entry point for the agent.
   * @param {string} guestMessage
   * @param {object} context - reservation/inquiry info + conversation history etc.
   */
  async processMessage(guestMessage, context = {}) {
    const system = await this.loadPrompt();

    // Build a rich user prompt (we will evolve this heavily)
    const userPrompt = this._buildUserPrompt(guestMessage, context);

    const raw = await this.llm.complete(system, userPrompt);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Attempt to extract JSON if the model wrapped it in markdown
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('Agent returned invalid JSON: ' + raw);
      }
    }

    // Normalize
    return {
      typeOfMessageReceived: parsed.typeOfMessageReceived || 'OTHER_MESSAGE',
      proposedResponse: parsed.proposedResponse || 'none',
      shouldReply: parsed.shouldReply ?? (parsed.proposedResponse && parsed.proposedResponse !== 'none'),
      confidence: parsed.confidence ?? 0.7,
      rawModelOutput: raw
    };
  }

  _buildUserPrompt(message, context) {
    const lines = [
      `Current guest message: "${message}"`,
      '',
      'Context:'
    ];

    if (context.guestName) lines.push(`- Guest name: ${context.guestName}`);
    if (context.checkIn) lines.push(`- Check-in: ${context.checkIn}`);
    if (context.checkOut) lines.push(`- Check-out: ${context.checkOut}`);
    if (context.listingId) lines.push(`- Listing ID: ${context.listingId}`);
    if (context.hasPets) lines.push(`- Pets: ${context.petCount || 'yes'}`);
    if (context.propertyName) lines.push(`- Property: ${context.propertyName}`);

    if (context.conversationHistory?.length) {
      lines.push('- Recent conversation (newest last):');
      context.conversationHistory.slice(-6).forEach(m => {
        const who = m.sender_type === 'guest' ? 'Guest' : 'Host';
        lines.push(`  ${who}: ${m.body}`);
      });
    }

    lines.push('');
    lines.push('Respond with the required JSON only.');

    return lines.join('\n');
  }

  /**
   * Higher-level entry point that mimics production behavior.
   * Calls processMessage and automatically triggers escalation
   * (notification) when the agent decides not to send an auto-reply.
   *
   * This is the recommended method to use in the simulator and when
   * testing real scenarios.
   */
  async handleMessage(guestMessage, context = {}) {
    const decision = await this.processMessage(guestMessage, context);

    const shouldEscalate =
      decision.shouldReply === false ||
      (decision.typeOfMessageReceived === 'OTHER_MESSAGE' && decision.proposedResponse === 'none');

    if (shouldEscalate) {
      await this.notification.notifyEscalation({
        decision,
        guestMessage,
        context,
      });
    }

    return {
      ...decision,
      escalated: shouldEscalate,
    };
  }
}
