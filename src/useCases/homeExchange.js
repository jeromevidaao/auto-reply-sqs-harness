/**
 * Isolated HomeExchange auto-reply use case.
 *
 * Intentionally separate from the Airbnb / Hospitable GuestMessagingAgent
 * pipeline so existing categories cannot be changed by HE traffic.
 *
 * First guest message:
 *   1) Confirm the Hospitable calendar is open for the requested nights
 *      (request can be accepted).
 *   2) Load the unit cleaning fee from DynamoDB `listing`.
 *   3) Draft a reply asking if they will pay that fee after the stay.
 *
 * Send is ALWAYS disabled for this use case (draft only).
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';

export const HOMEEXCHANGE_PLATFORM = 'homeexchange';
export const HOMEEXCHANGE_ACT = 'homeexchange_message';

/** HomeExchange home that maps to Pine Apt #3. */
export const HE_HOME_ID = '3202475';
export const APT3_HOSPITABLE_PROPERTY_ID = '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd';
export const APT3_AIRBNB_LISTING_ID = '24259977';
export const APT3_PROPERTY_NAME = 'Pine Apt #3';
export const LISTING_TABLE = 'listing';

/** Fallback only when DynamoDB `listing.price` cannot be read. */
export const DEFAULT_CLEANING_FEES = {
  '20904545': 80, // Pine Apt #1B
  '20150380': 120, // Pine Apt #2
  '24259977': 125, // Pine Apt #3
};

export function collectPayloadCandidates(event) {
  const out = [];
  if (!event || typeof event !== 'object') return out;
  out.push(event);

  const recordBody = event?.Records?.[0]?.body;
  if (typeof recordBody === 'string') {
    try {
      const parsed = JSON.parse(recordBody);
      out.push(parsed);
      if (typeof parsed?.body === 'string') {
        try {
          out.push(JSON.parse(parsed.body));
        } catch {
          /* ignore nested parse */
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (typeof event.body === 'string') {
    try {
      out.push(JSON.parse(event.body));
    } catch {
      /* ignore */
    }
  }

  return out;
}

/**
 * Strict detector. Hospitable/Airbnb traffic uses act=message / platform=airbnb
 * / source=platform and must NEVER match.
 */
export function isHomeExchangePayload(event) {
  const candidates = collectPayloadCandidates(event);
  for (const p of candidates) {
    if (!p || typeof p !== 'object') continue;
    const act = p?.queryStringParameters?.act || p?.act || null;
    if (act === HOMEEXCHANGE_ACT) return true;
    // Reservation calendar-sync act is a different product path — never treat as HE chat.
    if (act === 'new_reservation_home_exchange') continue;

    const data = p.data && typeof p.data === 'object' ? p.data : {};
    const ctx = p.context && typeof p.context === 'object' ? p.context : {};
    const platform = String(
      p.platform ||
        data.platform ||
        ctx.platform ||
        p.listing?.platform ||
        data.listing?.platform ||
        ctx.listing?.platform ||
        ''
    ).toLowerCase();
    const source = String(p.source || data.source || ctx.source || '').toLowerCase();
    const channel = String(p.channel || data.channel || ctx.channel || '').toLowerCase();
    if (
      platform === HOMEEXCHANGE_PLATFORM ||
      source === HOMEEXCHANGE_PLATFORM ||
      channel === HOMEEXCHANGE_PLATFORM
    ) {
      return true;
    }
  }
  return false;
}

export function dateOnly(value) {
  if (!value) return null;
  const s = String(value).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return null;
}

export function addDaysYmd(ymd, delta) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Occupied nights are [checkIn, checkOut). */
export function stayNights(checkIn, checkOut) {
  const start = dateOnly(checkIn);
  const end = dateOnly(checkOut);
  if (!start || !end || start >= end) return [];
  const nights = [];
  let cursor = start;
  while (cursor < end) {
    nights.push(cursor);
    cursor = addDaysYmd(cursor, 1);
  }
  return nights;
}

export function formatStayRange(checkIn, checkOut) {
  const start = dateOnly(checkIn);
  const end = dateOnly(checkOut);
  if (!start || !end) return null;
  const startDt = new Date(`${start}T12:00:00Z`);
  const endDt = new Date(`${end}T12:00:00Z`);
  const month = startDt.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const startDay = startDt.getUTCDate();
  const endDay = endDt.getUTCDate();
  const startYear = startDt.getUTCFullYear();
  const endYear = endDt.getUTCFullYear();
  const endMonth = endDt.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  if (startYear === endYear && month === endMonth) {
    return `${month} ${startDay}–${endDay}, ${startYear}`;
  }
  if (startYear === endYear) {
    return `${month} ${startDay} – ${endMonth} ${endDay}, ${startYear}`;
  }
  return `${month} ${startDay}, ${startYear} – ${endMonth} ${endDay}, ${endYear}`;
}

export function extractHomeExchangeMessage(event) {
  if (event?.message && (event.context?.platform === HOMEEXCHANGE_PLATFORM || event.context?.source === HOMEEXCHANGE_PLATFORM)) {
    return { message: String(event.message || ''), context: { ...event.context } };
  }

  const candidates = collectPayloadCandidates(event);
  for (const p of candidates) {
    if (!p || typeof p !== 'object') continue;
    // API Gateway envelopes keep the webhook as a JSON string in `body`.
    // collectPayloadCandidates already parsed that string — skip the envelope.
    if (typeof p.body === 'string' && p.queryStringParameters) continue;

    const data = p.data && typeof p.data === 'object' ? p.data : null;
    const src = data || p;
    const platform = String(
      src.platform || p.platform || src.listing?.platform || ''
    ).toLowerCase();
    const act = p?.queryStringParameters?.act || p?.act;
    const source = String(src.source || p.source || '').toLowerCase();
    if (
      platform !== HOMEEXCHANGE_PLATFORM &&
      act !== HOMEEXCHANGE_ACT &&
      source !== HOMEEXCHANGE_PLATFORM
    ) {
      continue;
    }
    const body = src.body || src.message || src.content || p.message || '';
    if (typeof body === 'string' && body.trim().startsWith('{')) continue;
    return {
      message: String(body || ''),
      context: {
        ...src,
        conversation_id: src.conversation_id || src.conversationId || null,
        guestName: src.guestName || src.sender?.first_name || src.sender?.full_name || null,
        checkIn: src.checkIn || src.check_in || null,
        checkOut: src.checkOut || src.check_out || null,
        isFirstMessage: src.isFirstMessage === true || src.is_first_message === true,
        messageCount: src.messageCount != null ? Number(src.messageCount) : null,
        propertyName: src.propertyName || src.property?.name || APT3_PROPERTY_NAME,
        listingId: src.listingId || src.property?.id || APT3_HOSPITABLE_PROPERTY_ID,
        airbnbListingId: src.airbnbListingId || APT3_AIRBNB_LISTING_ID,
        platform: HOMEEXCHANGE_PLATFORM,
        source: HOMEEXCHANGE_PLATFORM,
      },
    };
  }

  return { message: '', context: {} };
}

export function isFirstHomeExchangeMessage(context = {}, conversationHistory = []) {
  if (context.isFirstMessage === true) return true;
  if (context.isFirstMessage === false) return false;
  if (Number(context.messageCount) === 1) return true;
  const history = Array.isArray(conversationHistory)
    ? conversationHistory
    : Array.isArray(context.conversationHistory)
      ? context.conversationHistory
      : [];
  const priorGuest = history.filter((m) => {
    const role = String(m.sender_type || m.sender?.type || m.role || '').toLowerCase();
    return role === 'guest' || role === 'exchanger';
  });
  return priorGuest.length <= 1;
}

function calendarDayAvailable(entry) {
  if (!entry) return false;
  if (entry.status && typeof entry.status === 'object') {
    return entry.status.available === true;
  }
  if (entry.available === true || entry.available === 'true') return true;
  if (entry.available === false || entry.blocked === true) return false;
  const status = String(entry.status || '').toLowerCase();
  return status === 'available' || status === 'open';
}

function reservationOccupiesNight(reservation, night) {
  const cat = String(
    reservation?.reservation_status?.current?.category || reservation?.status || ''
  ).toLowerCase();
  if (cat === 'cancelled' || cat === 'not accepted' || cat === 'denied' || cat === 'expired') {
    return false;
  }
  const ci = dateOnly(reservation.check_in || reservation.arrival_date || reservation.checkIn);
  const co = dateOnly(reservation.check_out || reservation.departure_date || reservation.checkOut);
  if (!ci || !co) return false;
  return ci <= night && night < co;
}

export function analyzeCalendarOpen({ calendarDays = [], reservations = [], checkIn, checkOut } = {}) {
  const nights = stayNights(checkIn, checkOut);
  if (!nights.length) {
    return {
      checked: false,
      open: false,
      nights,
      available: [],
      unavailable: nights,
      reason: 'missing_dates',
    };
  }

  const byDate = {};
  for (const day of calendarDays || []) {
    const d = dateOnly(day.date || day.day);
    if (d) byDate[d] = day;
  }

  const available = [];
  const unavailable = [];
  const reasons = {};

  for (const night of nights) {
    const calOk = calendarDayAvailable(byDate[night]);
    const blockers = (reservations || []).filter((r) => reservationOccupiesNight(r, night));
    if (calOk && blockers.length === 0) {
      available.push(night);
    } else {
      unavailable.push(night);
      reasons[night] = {
        calendarOpen: calOk,
        reservationBlocked: blockers.length > 0,
      };
    }
  }

  const calendarFetched = Array.isArray(calendarDays) && calendarDays.length > 0;
  return {
    checked: calendarFetched,
    open: calendarFetched && unavailable.length === 0,
    nights,
    available,
    unavailable,
    reasons,
  };
}

export async function loadCleaningFeeFromDdb(ddbClient, airbnbListingId = APT3_AIRBNB_LISTING_ID) {
  const listingId = String(airbnbListingId || APT3_AIRBNB_LISTING_ID);
  const fallback = DEFAULT_CLEANING_FEES[listingId] ?? DEFAULT_CLEANING_FEES[APT3_AIRBNB_LISTING_ID];
  if (!ddbClient || typeof ddbClient.send !== 'function') {
    return { amount: fallback, source: 'default_no_client', listingId };
  }

  const keys = [{ listingId: Number(listingId) }, { listingId }];
  for (const Key of keys) {
    try {
      const out = await ddbClient.send(
        new GetCommand({
          TableName: LISTING_TABLE,
          Key,
          ProjectionExpression: 'listingId, #n, price',
          ExpressionAttributeNames: { '#n': 'name' },
        })
      );
      const item = out?.Item;
      const price = item?.price != null ? Number(item.price) : NaN;
      if (!Number.isNaN(price) && price > 0) {
        return {
          amount: price,
          source: 'ddb_listing',
          listingId,
          listingName: item.name || null,
        };
      }
    } catch (err) {
      return {
        amount: fallback,
        source: 'default_ddb_error',
        listingId,
        error: err?.message || String(err),
      };
    }
  }

  return { amount: fallback, source: 'default_missing_row', listingId };
}

export function buildHomeExchangeDraft({
  guestName,
  checkIn,
  checkOut,
  calendar,
  cleaningFee,
  isFirst,
} = {}) {
  const name = (guestName || 'there').split(/\s+/)[0];
  const range = formatStayRange(checkIn, checkOut);
  const fee = cleaningFee?.amount;

  if (!isFirst) {
    return {
      typeOfMessageReceived: 'HOMEEXCHANGE_FOLLOWUP',
      shouldReply: false,
      proposedResponse: null,
      reason: 'homeexchange_followup_send_disabled',
    };
  }

  if (!calendar?.checked) {
    return {
      typeOfMessageReceived: 'HOMEEXCHANGE_FIRST_MESSAGE',
      shouldReply: true,
      proposedResponse:
        `Hi ${name}, thanks for your message. I'm checking whether those dates are open on our calendar and will follow up shortly about the stay and the cleaning fee.`,
      reason: 'calendar_not_checked',
    };
  }

  if (!calendar.open) {
    const blocked = (calendar.unavailable || []).join(', ');
    return {
      typeOfMessageReceived: 'HOMEEXCHANGE_FIRST_MESSAGE',
      shouldReply: true,
      proposedResponse:
        `Hi ${name}, thanks for reaching out. I checked our calendar` +
        (range ? ` for ${range}` : '') +
        ` and those dates are not open, so we can't accept the request as it stands.` +
        (blocked ? ` Unavailable night(s): ${blocked}.` : ''),
      reason: 'calendar_not_open',
    };
  }

  const feeText =
    fee != null && !Number.isNaN(Number(fee))
      ? `$${Number(fee)}`
      : 'our standard cleaning fee';

  return {
    typeOfMessageReceived: 'HOMEEXCHANGE_FIRST_MESSAGE',
    shouldReply: true,
    proposedResponse:
      `Hi ${name}, thanks for your message` +
      (range ? ` — ${range} is open on our calendar` : '') +
      `, so we can accept the request.\n\n` +
      `One thing we ask for Home Exchange stays: the cleaning fee after you leave is ${feeText}. ` +
      `Would you be okay paying that after your stay?`,
    reason: 'calendar_open_ask_cleaning_fee',
  };
}

export async function handleHomeExchangeMessage({
  event,
  hospitableClient = null,
  ddbClient = null,
} = {}) {
  const extracted = extractHomeExchangeMessage(event);
  const message = extracted.message;
  const context = extracted.context || {};
  const checkIn = dateOnly(context.checkIn || context.check_in);
  const checkOut = dateOnly(context.checkOut || context.check_out);
  const isFirst = isFirstHomeExchangeMessage(context, context.conversationHistory);
  const propertyId = context.listingId || APT3_HOSPITABLE_PROPERTY_ID;
  const airbnbListingId = context.airbnbListingId || APT3_AIRBNB_LISTING_ID;
  const guestName = context.guestName || context.sender?.first_name || null;

  let calendarDays = [];
  let reservations = [];
  let calendarError = null;
  let reservationsError = null;

  if (isFirst && checkIn && checkOut && hospitableClient) {
    try {
      if (typeof hospitableClient.getPropertyCalendar === 'function') {
        calendarDays = await hospitableClient.getPropertyCalendar(propertyId, checkIn, checkOut);
      }
    } catch (err) {
      calendarError = err?.message || String(err);
    }
    try {
      const resStart = addDaysYmd(checkIn, -14);
      const resEnd = addDaysYmd(checkOut, 14);
      if (typeof hospitableClient.getPropertyReservations === 'function') {
        reservations = await hospitableClient.getPropertyReservations(propertyId, resStart, resEnd);
      } else if (typeof hospitableClient.getReservations === 'function') {
        reservations = await hospitableClient.getReservations({
          properties: propertyId,
          start_date: resStart,
          end_date: resEnd,
          per_page: 100,
        });
      }
    } catch (err) {
      reservationsError = err?.message || String(err);
    }
  }

  const calendar = analyzeCalendarOpen({
    calendarDays,
    reservations,
    checkIn,
    checkOut,
  });

  let cleaningFee = {
    amount: DEFAULT_CLEANING_FEES[airbnbListingId] ?? 125,
    source: 'default',
    listingId: airbnbListingId,
  };
  if (isFirst && calendar.open) {
    cleaningFee = await loadCleaningFeeFromDdb(ddbClient, airbnbListingId);
  }

  const draft = buildHomeExchangeDraft({
    guestName,
    checkIn,
    checkOut,
    calendar,
    cleaningFee,
    isFirst,
  });

  return {
    platform: HOMEEXCHANGE_PLATFORM,
    sendDisabled: true,
    sent: false,
    isFirstMessage: isFirst,
    guestMessage: message,
    guestName,
    checkIn,
    checkOut,
    propertyId,
    airbnbListingId,
    calendar,
    cleaningFee,
    calendarError,
    reservationsError,
    typeOfMessageReceived: draft.typeOfMessageReceived,
    shouldReply: draft.shouldReply,
    proposedResponse: draft.proposedResponse,
    reason: draft.reason,
    escalated: false,
  };
}
