import { BaseTool } from '../BaseTool.js';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  airbnbListingIdFromContext,
  checkInYmdFromContext,
  previousYmd,
  ymdInAmericaNewYork,
} from '../../utils/guestCheckIns.js';

/**
 * UnitReadinessTool
 *
 * Ground truth for check-in-day "is the unit ready?":
 * - DynamoDB `cleaning` row `{airbnbListingId}_{YYYY-MM-DD}` with `pressedAt`
 *   means the physical cleaning button was pushed that day (unit is clean).
 * - Missing row / no `pressedAt` after a previous-night guest = not ready.
 *
 * Do not tell guests about the button; that field is for the agent/policy.
 */
export class UnitReadinessTool extends BaseTool {
  constructor({ ddbClient = null, hospitableClient = null } = {}) {
    super({
      name: 'get_unit_readiness',
      description:
        'Checks if a property is ready for guest arrival from the cleaning DynamoDB table (button press) and previous-night occupancy via Hospitable.',
    });

    this.ddbClient = ddbClient;
    this.hospitableClient = hospitableClient;
    this.cleaningTableName = process.env.CLEANING_TABLE_NAME || 'cleaning';
  }

  async execute(input = {}, context = {}) {
    const merged = { ...context, ...input };
    const propertyUuid = String(merged.listingId || merged.listing_id || merged.propertyId || '').trim();
    const airbnbListingId = airbnbListingIdFromContext(merged);
    const checkInYmd =
      checkInYmdFromContext(merged) ||
      (typeof input?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date.slice(0, 10))
        ? input.date.slice(0, 10)
        : '');
    const todayYmd = this._todayYmd(merged);
    const cleaningYmd = checkInYmd || todayYmd;

    if (!airbnbListingId && !propertyUuid) {
      throw new Error('listingId is required for UnitReadinessTool');
    }

    const previousDate = previousYmd(cleaningYmd);
    const ddbKey = airbnbListingId ? `${airbnbListingId}_${cleaningYmd}` : '';

    console.log(
      `[UnitReadinessTool] Checking readiness listing=${propertyUuid || '(none)'} airbnb=${airbnbListingId || '(none)'} date=${cleaningYmd} key=${ddbKey || '(none)'}`
    );

    const cleaning = await this._getCleaningRow(ddbKey);
    const hadPreviousDayGuests = await this._checkPreviousDayOccupancy(
      propertyUuid || airbnbListingId,
      previousDate
    );

    const buttonPressed = !!cleaning.pressedAt;
    let isUnitReady;
    let reason;
    if (!hadPreviousDayGuests) {
      isUnitReady = true;
      reason = 'No guests the previous night — unit should be ready.';
    } else if (buttonPressed) {
      isUnitReady = true;
      reason = 'Previous-night guest checked out and cleaning is complete.';
    } else {
      isUnitReady = false;
      reason =
        'Previous-night guest checked out and cleaning is not complete yet. Guest will be messaged when the unit is ready.';
    }

    return {
      detected: true,
      listingId: propertyUuid || airbnbListingId,
      airbnbListingId: airbnbListingId || null,
      date: cleaningYmd,
      cleaningKey: ddbKey || null,
      isUnitReady,
      buttonPressed,
      pressedAt: cleaning.pressedAt,
      hadSameDayTurnover: hadPreviousDayGuests,
      hadPreviousDayGuests,
      reason,
      source: cleaning.lookedUp ? 'internal_cleaning_table' : 'hospitable_previous_day_check',
    };
  }

  _todayYmd(context = {}) {
    const anchor = context.asOfDate || context.simulatedToday || context.today;
    if (anchor) return String(anchor).slice(0, 10);
    if (context.asOfInstant) return ymdInAmericaNewYork(context.asOfInstant);
    return ymdInAmericaNewYork();
  }

  async _getCleaningRow(ddbKey) {
    if (!ddbKey) {
      return { lookedUp: false, found: false, pressedAt: null };
    }
    if (!this.ddbClient) {
      console.warn('[UnitReadinessTool] No DDB client provided. Cannot check cleaning table.');
      return { lookedUp: false, found: false, pressedAt: null };
    }

    try {
      const result = await this.ddbClient.send(
        new GetCommand({
          TableName: this.cleaningTableName,
          Key: { listingIdAndDate: ddbKey },
        })
      );
      const item = result?.Item || null;
      const pressedAt = item?.pressedAt || null;
      console.log(
        `[UnitReadinessTool] DDB ${ddbKey}: ${item ? 'FOUND' : 'NOT FOUND'} pressedAt=${pressedAt || 'none'}`
      );
      return { lookedUp: true, found: !!item, pressedAt };
    } catch (err) {
      console.error('[UnitReadinessTool] Error checking DDB cleaning table:', err.message);
      return { lookedUp: false, found: false, pressedAt: null };
    }
  }

  async _checkPreviousDayOccupancy(listingId, date) {
    if (!listingId || !date) {
      return true;
    }
    if (!this.hospitableClient) {
      console.warn('[UnitReadinessTool] No Hospitable client provided. Cannot check previous day occupancy.');
      return true;
    }

    try {
      const hadGuests = await this.hospitableClient.hasGuestsOnDate(listingId, date);
      console.log(
        `[UnitReadinessTool] Hospitable check for ${listingId} on ${date}: ${hadGuests ? 'HAD GUESTS' : 'NO GUESTS'}`
      );
      return !!hadGuests;
    } catch (err) {
      console.error('[UnitReadinessTool] Error calling Hospitable:', err.message);
      return true;
    }
  }
}
