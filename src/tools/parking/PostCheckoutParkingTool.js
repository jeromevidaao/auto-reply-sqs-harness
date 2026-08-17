import { BaseTool } from '../BaseTool.js';
import { resolveNowForGreeting } from '../../utils/timeGreeting.js';

/**
 * Pine units that share the off-street lot. Each guest has one dedicated spot.
 * After checkout we never let them keep *their* spot — cleaners and the next
 * booking need it. The only exception is a vacant *sibling* spot, and only
 * when the ask is the evening before checkout after 8pm ET (no new same-night
 * bookings after that).
 */
export const PINE_PARKING_UNITS = [
  {
    listingId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
    shortName: '1B',
    displayName: '1B',
  },
  {
    listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
    shortName: 'Apt 2',
    displayName: 'Apt 2',
  },
  {
    listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
    shortName: 'Apt 3',
    displayName: 'Apt 3',
  },
];

export const POST_CHECKOUT_PARKING_MAX_UNTIL = '1pm';
export const POST_CHECKOUT_PARKING_BOOKING_CUTOFF_HOUR_ET = 20;

/** Always said when we refuse the guest's own spot (refuse and exception paths). */
export const POST_CHECKOUT_PARKING_WHY =
  'the cleaning team needs that spot to clean the unit and get it ready for the next guests';

/**
 * Cassidy / Olivia class: leave the car after checkout or during checkout day.
 *
 * Production miss (Cassidy, Apt 2, 2026-08-16 5:56pm ET):
 *   "for tomorrow if we could leave the car in the parking spot during the day
 *    as we walk around? And what would be the latest check out time?"
 *   Bad auto: "yes you can leave the car in your dedicated spot ... Checkout is
 *    strictly at 10am."
 *   Ruby correction: do not leave it in the current spot; only a vacant sibling
 *    (1B) and only until 1pm.
 */
export class PostCheckoutParkingTool extends BaseTool {
  constructor({ hospitableClient = null } = {}) {
    super({
      name: 'check_post_checkout_parking',
      description:
        'Detects asks to leave a car after 10am checkout. Never allows the guest\'s own spot. After 8pm ET the evening before checkout, may offer one vacant sibling unit spot until 1pm.',
    });
    this.hospitableClient = hospitableClient;
  }

  static looksLikePostCheckoutParkingAsk(message = '') {
    const lower = String(message || '').toLowerCase();
    if (!lower.trim()) return false;

    const leaveCar =
      /(leave|keep|park)\s+(the\s+|our\s+|my\s+)?(car|vehicle)/i.test(lower) ||
      /car\s+(in|stay|remain|sit)/i.test(lower) ||
      /leave\s+it\s+in\s+(the\s+|our\s+|my\s+|your\s+)?(parking|spot|dedicated)/i.test(lower) ||
      /parking\s+spot\s+during/i.test(lower);

    if (!leaveCar) return false;

    // Amie: designated-spot before 4pm check-in is a different policy.
    const beforeCheckIn =
      /before.*(check-?in|4\s*pm|4pm)|prior to check|park.*before|before the check|ahead of check|earlier than 4/.test(
        lower
      );
    const alsoAfterCheckout = /(after|beyond|past).*(check\s*-?out|10)/.test(lower);
    if (beforeCheckIn && !alsoAfterCheckout) return false;

    const postCheckoutWindow =
      /during the day|after\s+(check\s*-?out|10)|beyond\s+(check\s*-?out|10)|later than\s*10|past\s+(check\s*-?out|10)|while we walk|as we walk|walk around|for (an hour|a few hours|the day)|tomorrow|check\s*-?out time|latest check|about to check\s*-?out|checking out|dedicated (parking )?spot/.test(
        lower
      );

    return postCheckoutWindow;
  }

  static nyParts(date) {
    const d = date instanceof Date ? date : new Date(date);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    let hour = parseInt(get('hour') ?? '0', 10);
    if (Number.isNaN(hour) || hour === 24) hour = 0;
    const y = get('year');
    const m = get('month');
    const day = get('day');
    return {
      hour,
      dateStr: `${y}-${m}-${day}`,
    };
  }

  static dateOnly(value) {
    if (!value) return null;
    const s = String(value);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return PostCheckoutParkingTool.nyParts(d).dateStr;
  }

  static addDaysStr(dateStr, days) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const utc = Date.UTC(y, m - 1, d + days);
    const iso = new Date(utc).toISOString();
    return iso.slice(0, 10);
  }

  static resolveNow(context = {}) {
    if (context.asOfInstant) {
      const d = new Date(context.asOfInstant);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (context.nowForGreeting instanceof Date && !Number.isNaN(context.nowForGreeting.getTime())) {
      return context.nowForGreeting;
    }
    if (context.now instanceof Date && !Number.isNaN(context.now.getTime())) {
      return context.now;
    }
    return resolveNowForGreeting(context);
  }

  static unitForListing(listingId) {
    return PINE_PARKING_UNITS.find((u) => u.listingId === listingId) || null;
  }

  /** Guest-facing label: "1B parking spot", "Apt 2 parking spot", "Apt 3 parking spot". */
  static spotLabel(shortName) {
    const name = String(shortName || '').trim();
    if (!name) return 'parking spot';
    return /parking spot/i.test(name) ? name : `${name} parking spot`;
  }

  static refuseSnippet() {
    return (
      `Checkout is strictly at 10am. We can't leave the car in your parking spot after that because ` +
      `${POST_CHECKOUT_PARKING_WHY}.`
    );
  }

  static exceptionSnippet(siblingShortName) {
    const label = PostCheckoutParkingTool.spotLabel(siblingShortName);
    return (
      `Checkout is strictly at 10am, so please don't leave the car in your current spot — ${POST_CHECKOUT_PARKING_WHY}. ` +
      `The ${label} will be free, so please put the car in the ${label}, and don't leave it after 1pm.`
    );
  }

  static siblingUnits(listingId) {
    return PINE_PARKING_UNITS.filter((u) => u.listingId !== listingId);
  }

  static reservationOccupiesNight(res, nightDate) {
    if (!res) return false;
    const status =
      res.reservation_status?.current?.category ||
      res.status ||
      res.reservationStatus ||
      '';
    if (/cancel/i.test(String(status))) return false;
    const arrival = PostCheckoutParkingTool.dateOnly(
      res.check_in || res.checkIn || res.arrival_date
    );
    const departure = PostCheckoutParkingTool.dateOnly(
      res.check_out || res.checkOut || res.departure_date
    );
    if (!arrival || !departure) return false;
    return arrival <= nightDate && departure > nightDate;
  }

  async execute(input, context = {}) {
    const message = typeof input === 'string' ? input : (input?.message || input?.guestMessage || '');
    if (!PostCheckoutParkingTool.looksLikePostCheckoutParkingAsk(message)) {
      return { detected: false };
    }

    const listingId = context.listingId || context.propertyId || null;
    const checkOut = PostCheckoutParkingTool.dateOnly(
      context.checkOut || context.check_out || context.departure_date
    );
    const now = PostCheckoutParkingTool.resolveNow(context);
    const ny = PostCheckoutParkingTool.nyParts(now);
    const dayBeforeCheckout = checkOut
      ? PostCheckoutParkingTool.addDaysStr(checkOut, -1)
      : null;
    const isDayBeforeCheckout = !!(checkOut && ny.dateStr === dayBeforeCheckout);
    const isAfter8pmEt = ny.hour >= POST_CHECKOUT_PARKING_BOOKING_CUTOFF_HOUR_ET;
    const ownUnit = PostCheckoutParkingTool.unitForListing(listingId);

    const result = {
      detected: true,
      listingId,
      ownUnitName: ownUnit?.shortName || context.propertyName || 'your unit',
      checkOut,
      nowEtDate: ny.dateStr,
      nowEtHour: ny.hour,
      isDayBeforeCheckout,
      isAfter8pmEt,
      occupancyChecked: false,
      vacantSibling: null,
      siblingOccupancy: [],
      exceptionEligible: false,
      reason: 'own_spot_never_allowed_after_10am',
      suggestedResponseSnippet: PostCheckoutParkingTool.refuseSnippet(),
    };

    if (!isDayBeforeCheckout || !isAfter8pmEt || !checkOut) {
      if (!isDayBeforeCheckout) result.reason = 'not_evening_before_checkout';
      else if (!isAfter8pmEt) result.reason = 'before_8pm_et_bookings_still_open';
      return result;
    }

    const siblings = PostCheckoutParkingTool.siblingUnits(listingId);
    if (!siblings.length) {
      result.reason = 'no_sibling_units';
      return result;
    }

    if (!this.hospitableClient) {
      result.reason = 'no_hospitable_client';
      return result;
    }

    try {
      for (const unit of siblings) {
        const occupied = await this._isOccupiedOnNight(unit.listingId, checkOut);
        result.siblingOccupancy.push({
          listingId: unit.listingId,
          shortName: unit.shortName,
          occupied,
        });
        if (occupied === false && !result.vacantSibling) {
          result.vacantSibling = {
            listingId: unit.listingId,
            shortName: unit.shortName,
            displayName: unit.displayName,
            spotLabel: PostCheckoutParkingTool.spotLabel(unit.shortName),
          };
        }
      }
      result.occupancyChecked = result.siblingOccupancy.every((row) => row.occupied !== null);
    } catch (err) {
      result.reason = `occupancy_check_failed:${err?.message || err}`;
      return result;
    }

    if (result.vacantSibling && result.occupancyChecked) {
      result.exceptionEligible = true;
      result.reason = 'sibling_vacant_after_8pm_day_before';
      result.suggestedResponseSnippet = PostCheckoutParkingTool.exceptionSnippet(
        result.vacantSibling.shortName
      );
    } else {
      result.reason = result.occupancyChecked
        ? 'no_vacant_sibling_for_checkout_night'
        : 'occupancy_unknown';
    }

    return result;
  }

  async _isOccupiedOnNight(listingId, nightDate) {
    const client = this.hospitableClient;
    if (!client || !listingId || !nightDate) return null;

    if (typeof client.hasGuestsOnDate === 'function') {
      return !!(await client.hasGuestsOnDate(listingId, nightDate));
    }

    if (typeof client.getPropertyReservations === 'function') {
      const start = PostCheckoutParkingTool.addDaysStr(nightDate, -1);
      const end = PostCheckoutParkingTool.addDaysStr(nightDate, 1);
      const rows = await client.getPropertyReservations(listingId, start, end);
      return (rows || []).some((r) =>
        PostCheckoutParkingTool.reservationOccupiesNight(r, nightDate)
      );
    }

    if (typeof client.getReservations === 'function') {
      const rows = await client.getReservations({
        properties: listingId,
        'arrival_date[lte]': nightDate,
        'departure_date[gt]': nightDate,
      });
      return (rows || []).some((r) =>
        PostCheckoutParkingTool.reservationOccupiesNight(r, nightDate)
      );
    }

    return null;
  }
}
