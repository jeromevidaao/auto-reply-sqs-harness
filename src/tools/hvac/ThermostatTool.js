import { BaseTool } from '../BaseTool.js';
import { headLayoutForListing, mixedModeRule } from './headLayout.js';

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
        warning: "Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat.",
        howTo: [
          'Use the dedicated heat pump remotes mounted on the wall in the bedroom and the kitchen.',
          'All of the wall units (bedroom and kitchen) need to be on the same mode — either all heat or all cool. If one is on heat and another is on cool, they will not work.',
          'If you want us to pre-set the temperature before arrival, just let us know.',
        ],
        proactiveHeat: "We've gone ahead and turned on the heat pump for you and set it to 72°F. It should warm up within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        proactiveCool: "We've gone ahead and turned on the AC for you and set it to 68°F. It should cool down within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        notes: 'The visible Nest on the wall is not connected to the actual system.',
      },

      // Apt 2
      '114663c5-0709-4eff-a868-fa9ebd6ed42d': {
        system: 'KumoCloud heat pump (3 indoor heads)',
        warning: "Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat.",
        howTo: [
          'There are wall units in the living room, the master bedroom, and the small bedroom. Each has its own heat pump remote on the wall.',
          'All of the wall units (living room, master bedroom, and small bedroom) need to be on the same mode — either all heat or all cool. If one is on heat and another is on cool, they will not work. You can still set a different temperature in each room.',
        ],
        proactiveHeat: "We've gone ahead and turned on the heat pump for you and set it to 72°F. It should warm up within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        proactiveCool: "We've gone ahead and turned on the AC for you and set it to 68°F. It should cool down within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        notes: 'Multiple indoor units — remotes are room-specific.',
      },

      // Apt 3
      '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd': {
        system: 'KumoCloud heat pump (3 indoor heads)',
        warning: "Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat.",
        howTo: [
          'There are wall units in the living room, the master bedroom, and the small bedroom. Look for the heat pump remotes on the wall in each of those rooms.',
          'All of the wall units (living room, master bedroom, and small bedroom) need to be on the same mode — either all heat or all cool. If one is on heat and another is on cool, they will not work. You can still set a different temperature in each room.',
        ],
        proactiveHeat: "We've gone ahead and turned on the heat pump for you and set it to 72°F. It should warm up within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        proactiveCool: "We've gone ahead and turned on the AC for you and set it to 68°F. It should cool down within 20-30 minutes. You can also adjust it yourself using the remotes on the wall in each room.",
        notes: 'Apt 3 has multiple indoor heads with individual wall remotes.',
      },
    };
    // Airbnb numeric listing ids resolve to the same copy as Hospitable UUIDs.
    this.instructionsByListing['20904545'] = this.instructionsByListing['c899481f-2e5b-402d-80c4-3167fd824d96'];
    this.instructionsByListing['20150380'] = this.instructionsByListing['114663c5-0709-4eff-a868-fa9ebd6ed42d'];
    this.instructionsByListing['24259977'] = this.instructionsByListing['60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd'];
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

    const seemsRelevant = this._isGuestMessageHvacRelevant(guestMessage);

    const intent = this._detectIntent(guestMessage);

    return {
      detected: true,
      listingId,
      system: unitInfo.system,
      warning: unitInfo.warning,
      howTo: unitInfo.howTo,
      notes: unitInfo.notes,
      guestMessageRelevant: seemsRelevant,
      intent,
      suggestedResponseSnippet: this._buildHelpfulSnippet(unitInfo, context.guestName, listingId),
      recommendedResponse: this._buildRecommendedResponse(unitInfo, guestMessage, context.guestName, listingId),
    };
  }

  /**
   * Detect genuine HVAC / comfort complaints. Uses word boundaries and phrase patterns
   * to avoid false positives (e.g. "hot" inside "hotel", "air" inside "Airbnb").
   */
  _isGuestMessageHvacRelevant(guestMessage = '') {
    const m = (guestMessage || '').toLowerCase();

    if (this._isRemotePerUnitQuestion(guestMessage)) {
      return false;
    }

    // Clear non-HVAC intents — never treat these as thermostat messages.
    if (/\bhotel recommendations?\b/.test(m) || /\brecommend(?:ations?)?\b.*\bhotels?\b/.test(m) || /\bhotels?\b.*\brecommend/.test(m)) {
      return false;
    }
    if (/\bairbnb\b/.test(m) && !this._hasExplicitHvacLanguage(m.replace(/\bairbnb\b/g, ' '))) {
      return false;
    }

    return this._hasExplicitHvacLanguage(m);
  }

  _isRemotePerUnitQuestion(guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    if (!/\bremote/.test(lower)) {
      return false;
    }

    const asksAboutSharedRemote =
      /\b(?:one|the|a|single)\b.{0,30}\bremote\b.{0,50}\b(?:both|two|all|multiple)\b/.test(lower) ||
      /\bremote\b.{0,50}\b(?:both|two|all)\b.{0,30}\b(?:unit|units|head|heads|room|rooms|air)\b/.test(lower) ||
      /\b(?:both|two|all)\b.{0,30}\b(?:unit|units|air)\b.{0,50}\b(?:one|the|a|single)\b.{0,20}\bremote\b/.test(lower) ||
      (/\b(?:both|two|all)\s+air\s+units?\b/.test(lower) && /\bremote/.test(lower));

    if (!asksAboutSharedRemote) {
      return false;
    }

    return !/\b(?:cold|hot|freezing|not (?:working|blowing|cooling)|no air|too (?:hot|cold)|turn (?:up|down)|broken|stuck|warm up|cool down)\b/.test(lower);
  }

  _hasExplicitHvacLanguage(m = '') {
    const hvacPatterns = [
      /\bthermostat\b/,
      /\btemperature\b/,
      /\btoo (?:hot|cold|warm|cool)\b/,
      /\b(?:cold|hot|freezing) in (?:here|the)\b/,
      /\bit'?s (?:cold|hot|freezing|boiling)\b/,
      /\bturn(?:ing)? (?:up|down) the heat\b/,
      /\bheat pump\b/,
      /\bair conditioning\b/,
      /\bno air\b/,
      /\b(?:ac|a\/c)\b/,
      /\bheat(?:ing)?\b/,
      /\bfreezing\b/,
      /\bnest\b/,
      /\bremotes?\b/,
      /\bno air coming\b/,
      /\b(?:either|both).{0,40}\bunits?\b/,
      /\bunits?\b.{0,30}(?:on|off|air|ac|heat|cool|remote|setting|blowing)/,
      /\bcool down\b/,
      /\bwarm up\b/,
    ];
    return hvacPatterns.some((p) => p.test(m));
  }

  _detectIntent(guestMessage = '') {
    const lower = guestMessage.toLowerCase();
    if (/\b(?:cold|freezing|turn up the heat|too cold)\b/.test(lower) || /\bit'?s cold\b/.test(lower)) return 'heat';
    if (/\b(?:too hot|too warm|no air|air conditioning|cool down)\b/.test(lower) || /\b(?:ac|a\/c)\b/.test(lower) || /\bit'?s hot\b/.test(lower)) return 'cool';
    return 'general';
  }

  _mixedModeLine(listingId, unitInfo) {
    const rooms = headLayoutForListing(listingId)?.rooms || [];
    const rule = mixedModeRule(rooms);
    const already = [...(unitInfo.howTo || []), unitInfo.warning || ''].join(' ');
    if (rule && !/same mode/i.test(already)) {
      return rule;
    }
    return null;
  }

  _buildHelpfulSnippet(unitInfo, guestName, listingId) {
    const name = guestName ? `${guestName}, ` : '';
    const parts = [];

    if (unitInfo.warning) {
      parts.push(unitInfo.warning);
    }

    parts.push(...unitInfo.howTo);
    const extra = this._mixedModeLine(listingId, unitInfo);
    if (extra) parts.push(extra);

    return `${name}${parts.join(' ')}`.trim();
  }

  _buildRecommendedResponse(unitInfo, guestMessage, guestName, listingId) {
    const name = guestName ? `${guestName}, ` : '';
    const intent = this._detectIntent(guestMessage);
    const parts = [unitInfo.warning];

    if (intent === 'heat' && unitInfo.proactiveHeat) {
      parts.push(unitInfo.proactiveHeat);
      parts.push(mixedModeRule(headLayoutForListing(listingId)?.rooms || []));
    } else if (intent === 'cool' && unitInfo.proactiveCool) {
      parts.push(unitInfo.proactiveCool);
      parts.push(mixedModeRule(headLayoutForListing(listingId)?.rooms || []));
    } else {
      parts.push(...unitInfo.howTo);
      const extra = this._mixedModeLine(listingId, unitInfo);
      if (extra) parts.push(extra);
    }

    return `${name}${parts.join(' ')}`.trim();
  }
}
