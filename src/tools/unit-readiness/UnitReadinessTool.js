import { BaseTool } from '../BaseTool.js';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

/**
 * UnitReadinessTool
 *
 * Determines whether a unit is likely ready for a new guest based on:
 * - Same-day turnover records in the "cleaning" DDB table
 * - Previous day's occupancy via Hospitable API
 *
 * This helps the agent give accurate information about early check-in / unit readiness.
 */
export class UnitReadinessTool extends BaseTool {
  constructor({ ddbClient = null, hospitableClient = null } = {}) {
    super({
      name: 'get_unit_readiness',
      description: 'Checks if a property is ready for guest arrival. Considers same-day turnovers (from internal cleaning table) and previous day occupancy via Hospitable.',
    });

    this.ddbClient = ddbClient;
    this.hospitableClient = hospitableClient;

    // You can configure the table name via env or constructor if needed
    this.cleaningTableName = process.env.CLEANING_TABLE_NAME || 'cleaning';
  }

  async execute(input, context = {}) {
    const listingId = context.listingId || input?.listingId;
    const targetDate = input?.date || context.checkIn || this._getToday();

    if (!listingId) {
      throw new Error('listingId is required for UnitReadinessTool');
    }

    console.log(`[UnitReadinessTool] Checking readiness for listing ${listingId} on ${targetDate}`);

    const previousDate = this._getPreviousDate(targetDate);
    const ddbKey = `${listingId}_${previousDate}`;

    // Step 1: Check internal "cleaning" table for same-day turnover
    const hadSameDayTurnover = await this._checkSameDayTurnover(ddbKey);

    if (hadSameDayTurnover) {
      return {
        detected: true,
        listingId,
        date: targetDate,
        isUnitReady: false, // They handle messaging separately when unit becomes ready
        hadSameDayTurnover: true,
        hadPreviousDayGuests: true, // implied by same-day turnover
        reason: 'Same-day turnover detected. Guest will be messaged when unit is ready.',
        source: 'internal_cleaning_table'
      };
    }

    // Step 2: No same-day turnover → check previous day occupancy via Hospitable
    const hadPreviousDayGuests = await this._checkPreviousDayOccupancy(listingId, previousDate);

    return {
      detected: true,
      listingId,
      date: targetDate,
      isUnitReady: !hadPreviousDayGuests,
      hadSameDayTurnover: false,
      hadPreviousDayGuests,
      reason: hadPreviousDayGuests
        ? 'Had guests the previous day → unit likely needs cleaning'
        : 'No guests previous day → unit should be ready',
      source: 'hospitable_previous_day_check'
    };
  }

  async _checkSameDayTurnover(ddbKey) {
    if (!this.ddbClient) {
      console.warn('[UnitReadinessTool] No DDB client provided. Cannot check cleaning table.');
      return false; // fail safe
    }

    try {
      const result = await this.ddbClient.send(
        new GetCommand({
          TableName: this.cleaningTableName,
          Key: { pk: ddbKey }   // Adjust key name if your table uses a different attribute (e.g. "id" or "key")
        })
      );

      const exists = !!result.Item;
      console.log(`[UnitReadinessTool] DDB check for ${ddbKey}: ${exists ? 'FOUND (same-day turnover)' : 'NOT FOUND'}`);
      return exists;
    } catch (err) {
      console.error('[UnitReadinessTool] Error checking DDB cleaning table:', err.message);
      return false; // fail safe
    }
  }

  async _checkPreviousDayOccupancy(listingId, date) {
    if (!this.hospitableClient) {
      console.warn('[UnitReadinessTool] No Hospitable client provided. Cannot check previous day occupancy.');
      return true; // fail safe → assume needs cleaning
    }

    try {
      // The HospitableClient should implement hasGuestsOnDate(listingId, date)
      const hadGuests = await this.hospitableClient.hasGuestsOnDate(listingId, date);
      console.log(`[UnitReadinessTool] Hospitable check for ${listingId} on ${date}: ${hadGuests ? 'HAD GUESTS' : 'NO GUESTS'}`);
      return hadGuests;
    } catch (err) {
      console.error('[UnitReadinessTool] Error calling Hospitable:', err.message);
      return true; // fail safe
    }
  }

  _getToday() {
    return new Date().toISOString().split('T')[0];
  }

  _getPreviousDate(dateStr) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() - 1);
    return date.toISOString().split('T')[0];
  }
}
