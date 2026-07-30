import { BaseTool } from '../BaseTool.js';

/**
 * HeatPumpTool (live KumoCloud)
 *
 * Provides *live* status from the KumoCloud API for the property's indoor units (heat pump heads).
 * Used for real troubleshooting of "AC on but no air", no heat, etc.
 *
 * Key behavior requested:
 * - On relevant guest messages (AC/heat complaints), fetch current per-unit state (mode, roomTemp, setpoints).
 * - Detect mixed modes (e.g. 2x cool + 1x heat on Apt 2 / Sunny) which is a known failure mode
 *   (system cannot heat and cool different rooms/heads at the same time; also causes the "very hot 80F unit" symptom).
 * - Automatically set *all* units for the listing to a consistent mode + temp (cool/auto 65F for AC issues,
 *   heat 72F for heating issues, or auto as appropriate).
 * - Return rich data + a suggested reply snippet so the agent can tell the guest:
 *     "I checked the heat pumps... one was set on heat while the others were on cool... I've set all of them to auto at 65°F now so it should cool down."
 *
 * The tool is intentionally proactive on clear complaints (it will perform the set).
 * It is safe because:
 * - Only acts on temp/AC/heat keywords.
 * - Only changes when it sees a real mismatch.
 * - Uses the exact same Kumo v3 endpoints + device serials as the prior production implementation.
 *
 * For local eval / tests without real Kumo creds, pass a mock via constructor or the client will
 * return graceful {error} objects.
 */
export class HeatPumpTool extends BaseTool {
  constructor(options = {}) {
    super({
      name: 'get_heat_pump_status',
      description: 'Returns live KumoCloud heat pump status (per indoor unit: current mode, room temp, setpoints) for the listing. On clear comfort complaints, will also auto-remediate mixed/wrong modes across all heads and report the fix. Use for any AC, heat, or temperature complaint.',
    });

    this.kumoClient = options.kumoClient || null;
  }

  async execute(input, context = {}) {
    const guestMessage = typeof input === 'string' ? input : (input?.message || input?.guestMessage || '');
    const listingId = context.listingId;
    const guestName = context.guestName || null;

    // Word-boundary / phrase-based relevance (same discipline as ThermostatTool).
    // Naive substring matching falsely treated "opportunity" as HVAC because it contains "unit"
    // (Olivia early-check-in 2026-07-30) and auto-set all heat pumps on a non-HVAC message.
    const seemsRelevant = this._isGuestMessageHvacRelevant(guestMessage);

    const result = {
      detected: false,
      listingId: listingId || null,
      liveStatus: null,
      actionTaken: null,
      guestMessageRelevant: seemsRelevant,
      suggestedResponseSnippet: null,
    };

    if (!listingId) {
      result.message = 'No listingId in context — cannot fetch live heat pump data.';
      return result;
    }

    if (!this.kumoClient) {
      // Graceful no-op when not wired (local tests without mock, or before full deploy)
      result.detected = seemsRelevant;
      result.message = 'KumoCloudClient not provided to HeatPumpTool (no live data).';
      if (seemsRelevant) {
        result.suggestedResponseSnippet = this._buildSoftInstructionSnippet(guestName);
      }
      return result;
    }

    try {
      // Always fetch live status for relevant messages (cheap, ~3 devices)
      const status = await this.kumoClient.getStatusForListing(listingId);
      result.liveStatus = status;
      result.detected = true;

      // If this looks like a real problem report, attempt auto-remediation via the client's helper.
      // The helper decides mode/temp based on keywords in the guest message and whether it sees mixed/wrong modes.
      if (seemsRelevant) {
        const fix = await this.kumoClient.ensureConsistentForComplaint(listingId, guestMessage);
        result.actionTaken = fix;

        result.suggestedResponseSnippet = this._buildLiveSnippet(guestName, status, fix);
      } else {
        result.suggestedResponseSnippet = this._buildSoftInstructionSnippet(guestName);
      }
    } catch (err) {
      result.error = err.message;
      result.detected = seemsRelevant;
      // Still give the guest the safe instruction even if live fetch failed
      result.suggestedResponseSnippet = this._buildSoftInstructionSnippet(guestName);
    }

    return result;
  }

  /**
   * Detect genuine HVAC / comfort complaints. Uses word boundaries and phrase patterns
   * to avoid false positives (e.g. "unit" inside "opportunity", "hot" inside "hotel",
   * "air" inside "Airbnb").
   */
  _isGuestMessageHvacRelevant(guestMessage = '') {
    const m = (guestMessage || '').toLowerCase();

    if (this._isRemotePerUnitQuestion(guestMessage)) {
      return false;
    }

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
      /\bstuffy\b/,
      /\bnot blowing\b/,
    ];
    return hvacPatterns.some((p) => p.test(m));
  }

  _buildSoftInstructionSnippet(guestName) {
    const name = guestName ? `${guestName}, ` : '';
    return `${name}Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat. Let me know the exact settings you see on the remotes and I'll check the units.`;
  }

  _buildLiveSnippet(guestName, status, fix) {
    const name = guestName ? `${guestName}, ` : '';
    const parts = [];

    const summary = status?.summary || {};
    const units = status?.units || [];

    if (fix && fix.fixed && fix.setResult) {
      const m = fix.recommendedMode || 'auto';
      const t = fix.recommendedTempF || 65;
      const beforeModes = (fix.before?.summary?.modes || []).join('/');
      const roomInfo = summary.avgRoomTempF ? ` (room ~${summary.avgRoomTempF}°F)` : '';

      parts.push(`Please make sure you are using the heat pump remotes on the wall in each room. I checked the heat pumps for you${roomInfo}.`);

      if (beforeModes) {
        parts.push(`Before, the modes were ${beforeModes}.`);
      }
      if (summary.mixedModes || (fix.before && fix.before.summary && fix.before.summary.mixedModes)) {
        parts.push('One (or more) was in the wrong mode for what you need — the system cannot cool and heat at the same time across heads.');
      }

      parts.push(`I've set all ${units.length || 'the'} units to ${m} at ${t}°F now so it should cool down shortly. You can still adjust with the wall remotes if you want.`);
      parts.push('Let me know in a few minutes if the air is moving and the temperature is improving!');
    } else if (status && !status.error) {
      // We have live data but did not need to (or could not) fix — still be helpful
      if (summary.mixedModes) {
        parts.push('Thanks for the details. I can see the heat pumps are in mixed modes right now, which prevents proper cooling/heating.');
      }
      parts.push(this._buildSoftInstructionSnippet(guestName).replace(`${name}`, name)); // reuse base
      parts.push('I also checked the live status of the units — let me know the exact remote settings you\'re seeing and I can dig deeper or adjust them for you.');
    } else {
      // fallback
      parts.push(this._buildSoftInstructionSnippet(guestName));
    }

    return `${name}${parts.join(' ')}`.trim();
  }
}

export default HeatPumpTool;
