import { BaseTool } from '../BaseTool.js';

/**
 * ThermostatTool
 *
 * The single source of truth for all guest-facing thermostat / heat pump instructions.
 *
 * Uses the exact language and rules that have proven effective in production:
 *   - Strong "do not touch the Nest" warnings (varies slightly per unit)
 *   - Primary control method = heat pump remotes on the wall in each room
 *   - Proactive host pre-heating/cooling language (72°F heat, 68°F cool)
 *   - Realistic 20-30 minute expectation for the space to change temperature
 *
 * Per-unit data accounts for different numbers of indoor heads and remote placement.
 */
export class ThermostatTool extends BaseTool {
  constructor() {
    super({
      name: 'get_thermostat_instructions',
      description: 'Returns accurate, unit-specific instructions for setting temperature, using the KumoCloud heat pump system, and warnings about any Nest thermostat that should not be touched.',
    });

    // Per-listingId thermostat knowledge.
    // These are the canonical instructions guests should receive.
    // Sourced and adapted from production behavior.
    this.instructionsByListing = {
      // 53 Pine #1B (Studio / Downtown)
      'c899481f-2e5b-402d-80c4-3167fd824d96': {
        system: 'KumoCloud heat pump (2 indoor heads)',
        warning: "Please don't use the Nest thermostat — it doesn't control the AC. Use the heat pump remotes on the wall in each room instead.",
        howTo: [
          'Use the dedicated heat pump remotes mounted on the wall in each room.',
          'If you want us to pre-set the temperature before arrival, just let us know.',
        ],
        proactiveHeat: "We've gone ahead and turned on the heat pump for you and set it to 72°F. It should warm up within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        proactiveCool: "We've gone ahead and turned on the AC for you and set it to 68°F. It should cool down within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        notes: 'The visible Nest on the wall is not connected to the actual system.',
      },

      // Apt 2
      '114663c5-0709-4eff-a868-fa9ebd6ed42d': {
        system: 'KumoCloud heat pump (3 indoor heads)',
        warning: "Please don't use the Nest thermostat if you see one — it doesn't control the AC or heat. Use the heat pump remotes on the wall in each room instead.",
        howTo: [
          'Each room has its own heat pump remote on the wall.',
          'You can control the temperature independently in different areas.',
        ],
        proactiveHeat: "We've gone ahead and turned on the heat pump for you and set it to 72°F. It should warm up within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        proactiveCool: "We've gone ahead and turned on the AC for you and set it to 68°F. It should cool down within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        notes: 'Multiple indoor units — remotes are room-specific.',
      },

      // Apt 3
      '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd': {
        system: 'KumoCloud heat pump (3 indoor heads)',
        warning: "Please don't use the Nest thermostat — it doesn't control the AC. Use the heat pump remotes on the wall in each room instead.",
        howTo: [
          'Look for the heat pump remotes on the wall in the main living area and bedrooms.',
          'Each remote controls the unit in that room.',
        ],
        proactiveHeat: "We've gone ahead and turned on the heat pump for you and set it to 72°F. It should warm up within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        proactiveCool: "We've gone ahead and turned on the AC for you and set it to 68°F. It should cool down within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        notes: 'Apt 3 has multiple indoor heads with individual wall remotes.',
      },
    };
  }

  async execute(input, context = {}) {
    const listingId = context.listingId;
    const guestMessage = typeof input === 'string' ? input : (input?.message || '');

    const unitInfo = this.instructionsByListing[listingId] || null;

    if (!unitInfo) {
      return {
        detected: false,
        system: 'KumoCloud heat pump',
        instructions: null,
        message: 'No specific thermostat instructions found for this listing yet.',
      };
    }

    // Simple heuristic: did the guest message seem related to temperature?
    const lowerMsg = guestMessage.toLowerCase();
    const tempKeywords = ['hot', 'cold', 'warm', 'cool', 'temperature', 'thermostat', 'heat', 'ac', 'air conditioning', 'too warm', 'too cold', 'freezing', 'boiling'];
    const seemsRelevant = tempKeywords.some(kw => lowerMsg.includes(kw));

    return {
      detected: true,
      listingId,
      system: unitInfo.system,
      warning: unitInfo.warning,
      howTo: unitInfo.howTo,
      notes: unitInfo.notes,
      guestMessageRelevant: seemsRelevant,
      suggestedResponseSnippet: this._buildHelpfulSnippet(unitInfo, context.guestName),
    };
  }

  _buildHelpfulSnippet(unitInfo, guestName) {
    const name = guestName ? `${guestName}, ` : '';
    const parts = [];

    if (unitInfo.warning) {
      parts.push(unitInfo.warning);
    }

    parts.push(...unitInfo.howTo);

    return `${name}${parts.join(' ')}`.trim();
  }
}
