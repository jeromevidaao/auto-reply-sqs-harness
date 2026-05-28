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
    this.propertiesDir = path.join(root, 'prompts', 'properties');
    this.systemPrompt = null;
  }

  /**
   * Loads the composed system prompt:
   * base.md + the relevant property-specific file (if listingId is known)
   */
  async loadPrompt(context = {}) {
    if (this.systemPrompt && !context.listingId) return this.systemPrompt;

    try {
      const base = await fs.readFile(this.promptPath, 'utf8');

      const propertyFile = this._getPropertyFile(context.listingId);
      let propertyKnowledge = '';

      if (propertyFile) {
        const propertyPath = path.join(this.propertiesDir, propertyFile);
        try {
          propertyKnowledge = await fs.readFile(propertyPath, 'utf8');
        } catch (e) {
          console.warn(`Could not load property file: ${propertyFile}`);
        }
      }

      const composed = [
        base,
        propertyKnowledge ? '\n\n' + propertyKnowledge : ''
      ].join('');

      // Cache only the base if no specific property
      if (!context.listingId) {
        this.systemPrompt = composed;
      }

      return composed;

    } catch (err) {
      console.error('Failed to load/composed prompt');
      throw err;
    }
  }

  _getPropertyFile(listingId) {
    if (!listingId) return null;

    const map = {
      'c899481f-2e5b-402d-80c4-3167fd824d96': '1b.md',   // 1B
      '114663c5-0709-4eff-a868-fa9ebd6ed42d': 'apt2.md', // Apt 2
      '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd': 'apt3.md', // Apt 3
    };

    return map[listingId] || null;
  }

  /**
   * Main entry point for the agent.
   * @param {string} guestMessage
   * @param {object} context - reservation/inquiry info + conversation history etc.
   */
  async processMessage(guestMessage, context = {}) {
    const system = await this.loadPrompt(context);

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
