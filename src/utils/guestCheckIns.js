/**
 * Schlage first unit-door PIN unlock — DynamoDB `guestCheckIns`.
 *
 * Same source of truth as the dashboard occupancy badge and HeatPump
 * hands-off: guestCheckInDetect writes `{airbnbListingId}_{YYYY-MM-DD}`
 * when the guest uses their keypad code for the first time.
 *
 * Fail-open: lookup errors never block a guest reply.
 */
import { UNIT_BY_LISTING } from '../useCases/keypadLockoutOccupancy.js';

export const GUEST_CHECKINS_TABLE = process.env.GUEST_CHECKINS_TABLE || 'guestCheckIns';

export const HOSPITABLE_UUID_TO_AIRBNB = Object.fromEntries(
  Object.values(UNIT_BY_LISTING).map((u) => [u.propertyId, String(u.listingId)])
);

export function airbnbListingIdFromContext(context = {}) {
  const numeric = String(
    context.airbnbListingId || context.airbnb_listing_id || ''
  ).trim();
  if (/^\d+$/.test(numeric)) return numeric;
  const listing = String(context.listingId || context.listing_id || '').trim();
  if (/^\d+$/.test(listing)) return listing;
  return HOSPITABLE_UUID_TO_AIRBNB[listing] || '';
}

export function guestCheckInKey(airbnbListingId, checkInYmd) {
  if (!airbnbListingId || !checkInYmd) return '';
  return `${airbnbListingId}_${String(checkInYmd).slice(0, 10)}`;
}

export function checkInYmdFromContext(context = {}) {
  const raw = context.checkIn || context.check_in || '';
  const ymd = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : '';
}

/** Calendar date in America/New_York (`YYYY-MM-DD`). Never use UTC `toISOString` for ops dates. */
export function ymdInAmericaNewYork(dateLike) {
  const d = dateLike instanceof Date ? dateLike : dateLike ? new Date(dateLike) : new Date();
  if (Number.isNaN(d.getTime())) {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function previousYmd(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function emptyResult(extra = {}) {
  return {
    guestArrived: false,
    checkedInAt: null,
    guestName: null,
    lockName: null,
    checkInKey: null,
    ...extra,
  };
}

export function parseGuestCheckInItem(item, checkInKey = '') {
  if (!item || !item.checkInKey) return emptyResult({ checkInKey: checkInKey || null });
  if (item.kind && item.kind !== 'checked_in') {
    return emptyResult({ checkInKey: item.checkInKey });
  }
  if (!item.checkedInAt) return emptyResult({ checkInKey: item.checkInKey });
  return {
    guestArrived: true,
    checkedInAt: item.checkedInAt,
    guestName: item.guestName || null,
    lockName: item.lockName || null,
    checkInKey: item.checkInKey,
  };
}

/**
 * @param {object} opts
 * @param {string} [opts.airbnbListingId]
 * @param {string} [opts.checkInYmd]
 * @param {object} [opts.context] used when listing/date omitted
 * @param {(args: { TableName: string, Key: object }) => Promise<{ Item?: object }>} [opts.getItem]
 * @param {string} [opts.table]
 */
export async function lookupGuestCheckIn(opts = {}) {
  const context = opts.context || {};
  const airbnbListingId = opts.airbnbListingId || airbnbListingIdFromContext(context);
  const checkInYmd = opts.checkInYmd || checkInYmdFromContext(context);
  const key = guestCheckInKey(airbnbListingId, checkInYmd);
  if (!key) return emptyResult();

  if (typeof opts.getItem === 'function') {
    try {
      const res = await opts.getItem({
        TableName: opts.table || GUEST_CHECKINS_TABLE,
        Key: { checkInKey: key },
      });
      return parseGuestCheckInItem(res?.Item, key);
    } catch {
      return emptyResult({ checkInKey: key });
    }
  }

  try {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const region = process.env.AWS_REGION || 'us-east-1';
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    const res = await ddb.send(
      new GetCommand({
        TableName: opts.table || GUEST_CHECKINS_TABLE,
        Key: { checkInKey: key },
        ProjectionExpression: 'checkInKey, checkedInAt, guestName, listingId, lockName, #k',
        ExpressionAttributeNames: { '#k': 'kind' },
      })
    );
    return parseGuestCheckInItem(res?.Item, key);
  } catch (err) {
    console.warn(
      '[guestCheckIns] lookup failed (fail-open, treat as not arrived):',
      err?.message || err
    );
    return emptyResult({ checkInKey: key });
  }
}
