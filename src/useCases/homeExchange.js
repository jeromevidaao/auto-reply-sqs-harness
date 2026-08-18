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
 *   3) Draft: acknowledge a specific detail from their first message
 *      (Airbnb-style first engagement), then dates-open + fee ask, or
 *      dates-not-open decline. Policy sentences stay deterministic.
 *   4) Send via the HomeExchange API (never Hospitable) when a client is provided.
 *
 * Follow-up (e.g. fee accepted + extra dates like Caroline Sep 30–Oct 3):
 *   1) Parse asked dates from the guest text (year = next future occurrence).
 *   2) Confirm Hospitable calendar + accepted reservations for those nights.
 *   3) Draft: acknowledge fee if they agreed *and we have not already thanked
 *      them for it* + say whether the new dates are open.
 *   4) Extra-date replies may still send. Confirmation is pre-approve + block
 *      + "I just sent you a pre-approval and blocked those dates" (never "you're booked").
 *
 * Full thread + reservation context (Katie double-thank 2026-08-17):
 *   Always fetch the live HE conversation (do not trust a truncated SQS
 *   snippet). If the guest already accepted the cleaning fee, put that on
 *   `heReservation.cleaningFeeAccepted` so later turns and shared categories
 *   see it. Never say "thanks for confirming the cleaning fee" twice.
 *
 * Extra night after a cancelled pre-approval (Katie 2026-08-17 Apt #2):
 *   Guest cancels the HE pre-approval, adds a night, and resubmits.
 *   1) Prefer live HE exchange dates (after they modified the request).
 *   2) Check Hospitable for the additional night. Prior nights we already
 *      blocked for the cancelled stay have no Airbnb reservation — treat
 *      those leftover USER blocks as open for this guest.
 *   3) Call out whether the extra night is free. Never ask for an Airbnb
 *      alteration request.
 *   4) If the extra night is free, pre-approve the new stay and block the
 *      full range on Hospitable again.
 *
 * Guest confirmed / finalized (Katie 2026-08-17 Apt #2, status 3):
 *   HE posts a type=1 / type_auto=2 system line
 *   ("{{firstname}} has finalized the exchange") and sets finalized_at.
 *   Conversation last_message often stays on the last host chat, so the
 *   poller also watches exchange status (act=homeexchange_approval_status).
 *   Thank them for confirming. Do not pre-approve, do not "You're welcome".
 *
 * Confirmation (fee accepted + original exchange dates available on Hospitable
 * AND on the HomeExchange home calendar):
 *   1) GET /v1/exchanges/{conversationId}/get-exchanges then
 *      PATCH /v1/exchanges/{conversationId}/approve with that array
 *   2) PUT Hospitable calendar available:false for [checkIn, checkOut)
 *   3) Persist the block for the 4-day expire-unblock job
 *   4) Send: "I just sent you a pre-approval and blocked those dates for you."
 *   Errors (already finalized, Hospitable PUT fail): notify Android, do not proceed.
 *   HE/Hospitable writes retry 4× with 5/15/30s backoff (~1 min) then SQS.
 *   Every successful HE guest send (and send-fail after retries) FCM the owner
 *   phone. Airbnb auto-replies are not notified this way.
 *
 * Shared categories (after HE-specific draft is not sendable):
 *   Thank-you, check-in 4pm, checkout 10am, parking, wifi, laundry, etc.
 *   Airbnb-only welcome / cancellation / payment stay off this path.
 *   Send is still HomeExchange-only.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { alreadySentEquivalent } from '../clients/HomeExchangeClient.js';
import {
  pickExchangeFromConversation,
  exchangeAlreadyApproved,
} from '../clients/homeExchangeExchange.js';
import { buildBlockRecord, createDdbBlockStore } from './homeExchangeBlocks.js';
import { notifyHeAutoReply, notifyHePreapproval } from './homeExchangeNotify.js';
import {
  isAirbnbOnlyHeCategory,
  runSharedHeCategories,
  shouldRunSharedHeCategories,
  thisTurnWantsHePreapprove,
  guestAcceptedCleaningFeeText,
  guestAskedToAddNights,
  threadHasCancelledPreapproval,
  guestResubmittedAfterHeCancel,
  guestFinalizedHeExchange,
} from './homeExchangeSharedCategories.js';
import {
  applyHeFirstAckWriter,
  buildHeFirstAckClause,
  composeHeFirstReply,
} from './homeExchangeFirstAck.js';

export const HOMEEXCHANGE_PLATFORM = 'homeexchange';
export const HOMEEXCHANGE_ACT = 'homeexchange_message';
export const HOMEEXCHANGE_APPROVAL_ACT = 'homeexchange_approval_status';
export const HOMEEXCHANGE_CHECKIN_ACT = 'homeexchange_checkin_instructions';

/** Pine HE home → Hospitable / Airbnb. Default only when the home id is missing. */
export const HE_HOME_ID = '3202475';
export const HE_UNIT_BY_HOME = {
  '3202475': {
    homeId: '3202475',
    propertyId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
    airbnbListingId: '24259977',
    propertyName: 'Pine Apt #3',
  },
  '3285044': {
    homeId: '3285044',
    propertyId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
    airbnbListingId: '20150380',
    propertyName: 'Pine Apt #2',
  },
  '3285159': {
    homeId: '3285159',
    propertyId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
    airbnbListingId: '20904545',
    propertyName: 'Pine Apt #1B',
  },
};
export const APT3_HOSPITABLE_PROPERTY_ID = HE_UNIT_BY_HOME[HE_HOME_ID].propertyId;
export const APT3_AIRBNB_LISTING_ID = HE_UNIT_BY_HOME[HE_HOME_ID].airbnbListingId;
export const APT3_PROPERTY_NAME = HE_UNIT_BY_HOME[HE_HOME_ID].propertyName;
export const LISTING_TABLE = 'listing';

export function resolveHeUnit(homeId) {
  const key = homeId != null ? String(homeId).trim() : '';
  return HE_UNIT_BY_HOME[key] || HE_UNIT_BY_HOME[HE_HOME_ID];
}

export function extractHeHomeId(src = {}) {
  const listing = src.listing && typeof src.listing === 'object' ? src.listing : {};
  const home = src.home && typeof src.home === 'object' ? src.home : {};
  const candidates = [
    listing.platform_id,
    src.homeId,
    src.home_id,
    listing.id,
    home.id,
    src.heHomeId,
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const key = String(c);
    if (HE_UNIT_BY_HOME[key]) return key;
  }
  for (const c of candidates) {
    if (c == null || c === '') continue;
    return String(c);
  }
  return null;
}

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
    if (
      act === HOMEEXCHANGE_ACT ||
      act === HOMEEXCHANGE_APPROVAL_ACT ||
      act === HOMEEXCHANGE_CHECKIN_ACT
    ) {
      return true;
    }
    // Reservation calendar-sync act is a different product path — never treat as HE chat.
    if (act === 'new_reservation_home_exchange') continue;
    if (act === 'keypad_lockout_notice') continue;
    if (act === 'ring_smoke_notice') continue;

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

const MONTH_NAME_TO_NUM = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_NAME_ALT = Object.keys(MONTH_NAME_TO_NUM).join('|');

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function ymd(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function utcTodayYmd(now = new Date()) {
  return ymd(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

/** Next future occurrence of month/day from `now` (today counts as future). */
export function inferYearForMonthDay(month, day, now = new Date()) {
  const year = now.getUTCFullYear();
  const candidate = ymd(year, month, day);
  return candidate >= utcTodayYmd(now) ? year : year + 1;
}

function buildAskedRange(month1, day1, month2, day2, explicitYear, now) {
  if (!month1 || !day1 || !month2 || !day2) return null;
  const startYear = explicitYear || inferYearForMonthDay(month1, day1, now);
  let endYear = explicitYear || startYear;
  let checkIn = ymd(startYear, month1, day1);
  let checkOut = ymd(endYear, month2, day2);
  if (checkOut <= checkIn) {
    endYear = startYear + 1;
    checkOut = ymd(endYear, month2, day2);
  }
  if (checkOut <= checkIn) return null;
  return {
    checkIn,
    checkOut,
    yearSource: explicitYear ? 'explicit' : 'inferred',
  };
}

/**
 * Pull a check-in/out range from follow-up text.
 * "September 30- October 3" on 2026-08-14 → 2026-09-30 / 2026-10-03.
 */
export function extractAskedStayDates(text, { now = new Date(), originalCheckIn = null, originalCheckOut = null } = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  const named = raw.match(
    new RegExp(
      `\\b(${MONTH_NAME_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|—|to|through|thru)\\s*(?:(${MONTH_NAME_ALT})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?`,
      'i'
    )
  );
  if (named) {
    return buildAskedRange(
      MONTH_NAME_TO_NUM[named[1].toLowerCase()],
      Number(named[2]),
      named[3] ? MONTH_NAME_TO_NUM[named[3].toLowerCase()] : MONTH_NAME_TO_NUM[named[1].toLowerCase()],
      Number(named[4]),
      named[5] ? Number(named[5]) : null,
      now
    );
  }

  const numeric = raw.match(
    /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:-|–|—|to|through|thru)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/
  );
  if (numeric) {
    const month1 = Number(numeric[1]);
    const day1 = Number(numeric[2]);
    const year1 = numeric[3]
      ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3])
      : null;
    const month2 = Number(numeric[4]);
    const day2 = Number(numeric[5]);
    const year2 = numeric[6]
      ? Number(numeric[6].length === 2 ? `20${numeric[6]}` : numeric[6])
      : year1;
    return buildAskedRange(month1, day1, month2, day2, year2 || year1, now);
  }

  const formatted = extractFormattedStayRange(raw);
  if (formatted) return formatted;

  const checkoutOnly = raw.match(
    new RegExp(
      `\\bcheck(?:ed|ing)?\\s+out(?:\\s+on|\\s+the)?\\s+(${MONTH_NAME_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?`,
      'i'
    )
  );
  if (checkoutOnly && originalCheckIn) {
    const month = MONTH_NAME_TO_NUM[checkoutOnly[1].toLowerCase()];
    const day = Number(checkoutOnly[2]);
    const year = checkoutOnly[3]
      ? Number(checkoutOnly[3])
      : inferYearForMonthDay(month, day, now);
    const checkOut = ymd(year, month, day);
    if (checkOut > originalCheckIn) {
      return { checkIn: originalCheckIn, checkOut, yearSource: checkoutOnly[3] ? 'explicit' : 'inferred' };
    }
  }

  if (
    guestAskedToAddNights(raw) &&
    originalCheckIn &&
    originalCheckOut
  ) {
    return {
      checkIn: originalCheckIn,
      checkOut: addDaysYmd(originalCheckOut, 1),
      yearSource: 'plus_one_night',
    };
  }

  return null;
}

export function extractFormattedStayRange(text) {
  const raw = String(text || '');
  const named = raw.match(
    new RegExp(
      `\\b(${MONTH_NAME_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|—)\\s*(?:(${MONTH_NAME_ALT})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?,\\s*(\\d{4})`,
      'i'
    )
  );
  if (!named) return null;
  return buildAskedRange(
    MONTH_NAME_TO_NUM[named[1].toLowerCase()],
    Number(named[2]),
    named[3] ? MONTH_NAME_TO_NUM[named[3].toLowerCase()] : MONTH_NAME_TO_NUM[named[1].toLowerCase()],
    Number(named[4]),
    Number(named[5]),
    new Date(`${named[5]}-01-01T12:00:00Z`)
  );
}

export function extraNightsOf(previousCheckIn, previousCheckOut, nextCheckIn, nextCheckOut) {
  const prev = new Set(stayNights(previousCheckIn, previousCheckOut));
  return stayNights(nextCheckIn, nextCheckOut).filter((night) => !prev.has(night));
}

export function isStayExtensionOf(previousCheckIn, previousCheckOut, nextCheckIn, nextCheckOut) {
  const prevIn = dateOnly(previousCheckIn);
  const prevOut = dateOnly(previousCheckOut);
  const nextIn = dateOnly(nextCheckIn);
  const nextOut = dateOnly(nextCheckOut);
  if (!prevIn || !prevOut || !nextIn || !nextOut) return false;
  if (nextIn === prevIn && nextOut === prevOut) return false;
  if (nextIn === prevIn && nextOut > prevOut) return true;
  if (nextOut === prevOut && nextIn < prevIn) return true;
  return false;
}

export function extractPriorPreapprovalStay(conversationHistory = []) {
  for (const m of conversationHistory || []) {
    const text = messageText(m);
    if (!/pre-approval/i.test(text) || !/blocked those dates/i.test(text)) continue;
    const range = extractFormattedStayRange(text) || extractAskedStayDates(text);
    if (range?.checkIn && range?.checkOut) return range;
  }
  return null;
}

export function formatNightList(nights = []) {
  if (!nights.length) return null;
  if (nights.length === 1) {
    const dt = new Date(`${nights[0]}T12:00:00Z`);
    return dt.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  return formatStayRange(nights[0], addDaysYmd(nights[nights.length - 1], 1));
}

export function resolveHeStayWindows({
  contextCheckIn,
  contextCheckOut,
  exchangeCheckIn,
  exchangeCheckOut,
  askedDates,
  priorPreapprovalStay,
} = {}) {
  const ctxIn = dateOnly(contextCheckIn);
  const ctxOut = dateOnly(contextCheckOut);
  const exIn = dateOnly(exchangeCheckIn);
  const exOut = dateOnly(exchangeCheckOut);
  const askedIn = askedDates?.checkIn || null;
  const askedOut = askedDates?.checkOut || null;
  const priorIn = priorPreapprovalStay?.checkIn || null;
  const priorOut = priorPreapprovalStay?.checkOut || null;

  const previousCheckIn = priorIn || ctxIn;
  const previousCheckOut = priorOut || ctxOut;
  const targetCheckIn = exIn || askedIn || ctxIn;
  const targetCheckOut = exOut || askedOut || ctxOut;

  return {
    previousCheckIn,
    previousCheckOut,
    targetCheckIn,
    targetCheckOut,
  };
}

export function guestAcceptedCleaningFee(text) {
  return guestAcceptedCleaningFeeText(text);
}

export function guestAskedToPreapprove(text) {
  return /\bpre-?approv|\bfinalize\b/i.test(String(text || ''));
}

function messageText(m) {
  return String(m?.content || m?.body || m?.text || '');
}

function isGuestHistoryMessage(m, guestName) {
  const role = String(m?.sender_type || m?.sender?.type || m?.role || '').toLowerCase();
  if (role === 'host') return false;
  if (role === 'guest' || role === 'exchanger') return true;
  const author = String(m?.author?.first_name || m?.sender?.first_name || '').toLowerCase();
  const guestFirst = String(guestName || '').trim().split(/\s+/)[0].toLowerCase();
  if (guestFirst && author && author === guestFirst) return true;
  return false;
}

/** Fee accepted on this message or an earlier guest message in the thread. */
export function guestAcceptedCleaningFeeInThread(text, conversationHistory = [], guestName = null) {
  if (guestAcceptedCleaningFee(text)) return true;
  return (conversationHistory || []).some(
    (m) => isGuestHistoryMessage(m, guestName) && guestAcceptedCleaningFee(messageText(m))
  );
}

const HOST_THANKED_CLEANING_FEE_RE =
  /thanks for confirming[\s\S]{0,80}cleaning fee|thank you for confirming[\s\S]{0,80}cleaning fee/i;

/** Host already acknowledged the cleaning-fee yes on this thread. */
export function hostAlreadyThankedCleaningFee(conversationHistory = []) {
  return (conversationHistory || []).some((m) => HOST_THANKED_CLEANING_FEE_RE.test(messageText(m)));
}

/** SQS / reservation envelope already marked the HE stay as fee-accepted. */
export function contextSaysCleaningFeeAccepted(context = {}) {
  if (!context || typeof context !== 'object') return false;
  if (context.cleaningFeeAccepted === true) return true;
  if (context.reservation?.cleaningFeeAccepted === true) return true;
  if (context.heReservation?.cleaningFeeAccepted === true) return true;
  return false;
}

/** Thank for the fee only the first time we acknowledge it. */
export function shouldThankForCleaningFee({ feeAccepted = false, alreadyThanked = false } = {}) {
  return !!feeAccepted && !alreadyThanked;
}

export function mergeHeConversationHistory(provided = [], live = []) {
  const out = [];
  const seen = new Set();
  for (const m of [...(Array.isArray(provided) ? provided : []), ...(Array.isArray(live) ? live : [])]) {
    if (!m || typeof m !== 'object') continue;
    const text = messageText(m).trim().toLowerCase();
    const role = String(m.sender_type || m.sender?.type || m.role || '').toLowerCase();
    const key = `${role}|${text}`;
    if (!text) {
      out.push(m);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

export async function loadHeConversationHistory({
  provided = [],
  conversationId = null,
  homeExchangeClient = null,
} = {}) {
  const base = Array.isArray(provided) ? provided : [];
  if (!conversationId || typeof homeExchangeClient?.listMessages !== 'function') {
    return { conversationHistory: base, historyFetched: false, historyError: null };
  }
  try {
    const raw = await homeExchangeClient.listMessages(conversationId);
    const live = Array.isArray(raw) ? raw : [];
    return {
      conversationHistory: mergeHeConversationHistory(base, live),
      historyFetched: true,
      historyError: null,
    };
  } catch (err) {
    return {
      conversationHistory: base,
      historyFetched: false,
      historyError: err?.message || String(err),
    };
  }
}

export function buildHeReservationContext({
  conversationId = null,
  exchange = null,
  guestName = null,
  checkIn = null,
  checkOut = null,
  homeId = null,
  propertyName = null,
  airbnbListingId = null,
  cleaningFee = null,
  cleaningFeeAccepted = false,
  cleaningFeeThanked = false,
} = {}) {
  return {
    platform: HOMEEXCHANGE_PLATFORM,
    conversationId: conversationId != null ? String(conversationId) : null,
    exchangeId: exchange?.id != null ? String(exchange.id) : null,
    status: exchange?.status ?? null,
    guestName: guestName || null,
    checkIn: checkIn || null,
    checkOut: checkOut || null,
    homeId: homeId != null ? String(homeId) : null,
    propertyName: propertyName || null,
    airbnbListingId: airbnbListingId || null,
    cleaningFee: cleaningFee?.amount ?? null,
    cleaningFeeAccepted: !!cleaningFeeAccepted,
    cleaningFeeThanked: !!cleaningFeeThanked,
  };
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

function contextWithResolvedUnit(src = {}) {
  const homeId = extractHeHomeId(src);
  const mapped = homeId && HE_UNIT_BY_HOME[String(homeId)] ? resolveHeUnit(homeId) : null;
  const unit = mapped || {
    homeId: src.homeId || HE_HOME_ID,
    propertyId: src.listingId || src.property?.id || APT3_HOSPITABLE_PROPERTY_ID,
    airbnbListingId: src.airbnbListingId || APT3_AIRBNB_LISTING_ID,
    propertyName: src.propertyName || src.property?.name || APT3_PROPERTY_NAME,
  };
  return {
    homeId: unit.homeId,
    listingId: unit.propertyId,
    airbnbListingId: unit.airbnbListingId,
    propertyName: unit.propertyName,
  };
}

export function extractHomeExchangeMessage(event) {
  if (event?.message && (event.context?.platform === HOMEEXCHANGE_PLATFORM || event.context?.source === HOMEEXCHANGE_PLATFORM)) {
    const ctx = event.context || {};
    return {
      message: String(event.message || ''),
      context: {
        ...ctx,
        ...contextWithResolvedUnit(ctx),
        conversationHistory: Array.isArray(ctx.conversationHistory) ? ctx.conversationHistory : [],
        cleaningFeeAccepted: contextSaysCleaningFeeAccepted(ctx),
        reservation: ctx.reservation || ctx.heReservation || null,
      },
    };
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
      act !== HOMEEXCHANGE_APPROVAL_ACT &&
      act !== HOMEEXCHANGE_CHECKIN_ACT &&
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
        guestPhone: src.guestPhone || src.phoneNumber || src.phone || src.guest?.phone || null,
        guestPhoneLast4: src.guestPhoneLast4 || src.phoneLast4 || src.last4 || null,
        phoneNumber: src.phoneNumber || src.guestPhone || src.phone || null,
        eventType: src.eventType || p.eventType || null,
        action: src.action || p.action || null,
        act: act || src.act || null,
        checkIn: src.checkIn || src.check_in || null,
        checkOut: src.checkOut || src.check_out || null,
        isFirstMessage: src.isFirstMessage === true || src.is_first_message === true,
        messageCount: src.messageCount != null ? Number(src.messageCount) : null,
        ...contextWithResolvedUnit(src),
        conversationHistory: Array.isArray(src.conversationHistory)
          ? src.conversationHistory
          : Array.isArray(p.conversationHistory)
            ? p.conversationHistory
            : [],
        cleaningFeeAccepted: contextSaysCleaningFeeAccepted(src) || contextSaysCleaningFeeAccepted(p),
        reservation: src.reservation || src.heReservation || p.reservation || null,
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
  if (Number(context.messageCount) > 1) return false;
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

const HE_CALENDAR_OPEN_TYPES = new Set([
  'NON_RECIPROCAL',
  'RECIPROCAL',
  'AVAILABLE',
  'OPEN',
]);
const HE_CALENDAR_CLOSED_TYPES = new Set([
  'RESERVED',
  'UNAVAILABLE',
  'BLOCKED',
  'CLOSED',
]);

export function heRangeCoversNight(range, night) {
  const start = dateOnly(range?.start_on || range?.startOn || range?.start);
  const end = dateOnly(range?.end_on || range?.endOn || range?.end);
  if (!start || !end || !night) return false;
  return start <= night && night < end;
}

export function heRangeIsOpen(range) {
  const t = String(range?.type || '').toUpperCase();
  if (HE_CALENDAR_CLOSED_TYPES.has(t)) return false;
  if (HE_CALENDAR_OPEN_TYPES.has(t)) return true;
  return false;
}

export function heNightOpen(ranges, night) {
  const covering = (ranges || []).filter((r) => heRangeCoversNight(r, night));
  if (!covering.length) return false;
  if (covering.some((r) => !heRangeIsOpen(r))) return false;
  return covering.some((r) => heRangeIsOpen(r));
}

/**
 * HE home calendar: a night is available if it falls in an open HE range
 * (NON_RECIPROCAL / RECIPROCAL). RESERVED or uncovered nights are not available.
 */
export function analyzeHeCalendarOpen({ ranges = [], checkIn, checkOut, leftoverNights = [] } = {}) {
  const nights = stayNights(checkIn, checkOut);
  const leftover = new Set(leftoverNights || []);
  if (!nights.length) {
    return {
      checked: false,
      open: false,
      nights,
      available: [],
      unavailable: nights,
      leftoverNights: [...leftover],
      reason: 'missing_dates',
    };
  }
  const fetched = Array.isArray(ranges);
  if (!fetched) {
    return {
      checked: false,
      open: false,
      nights,
      available: [],
      unavailable: nights,
      leftoverNights: [...leftover],
      reason: 'he_calendar_not_fetched',
    };
  }
  const available = [];
  const unavailable = [];
  for (const night of nights) {
    if (heNightOpen(ranges, night) || leftover.has(night)) available.push(night);
    else unavailable.push(night);
  }
  return {
    checked: true,
    open: unavailable.length === 0,
    nights,
    available,
    unavailable,
    leftoverNights: [...leftover],
    reason: unavailable.length === 0 ? 'he_calendar_open' : 'he_calendar_not_open',
  };
}

export function mergeStayCalendars(hospitable, heCalendar) {
  const hosp = hospitable || { checked: false, open: false };
  const he = heCalendar || { checked: false, open: false };
  const bothChecked = !!(hosp.checked && he.checked);
  return {
    ...hosp,
    heChecked: !!he.checked,
    heOpen: !!he.open,
    heUnavailable: he.unavailable || [],
    checked: bothChecked,
    open: bothChecked && !!hosp.open && !!he.open,
  };
}

export function analyzeCalendarOpen({
  calendarDays = [],
  reservations = [],
  checkIn,
  checkOut,
  leftoverNights = [],
} = {}) {
  const nights = stayNights(checkIn, checkOut);
  const leftover = new Set(leftoverNights || []);
  if (!nights.length) {
    return {
      checked: false,
      open: false,
      nights,
      available: [],
      unavailable: nights,
      leftoverNights: [...leftover],
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
    const leftoverOk = leftover.has(night) && blockers.length === 0;
    if ((calOk || leftoverOk) && blockers.length === 0) {
      available.push(night);
    } else {
      unavailable.push(night);
      reasons[night] = {
        calendarOpen: calOk,
        reservationBlocked: blockers.length > 0,
        leftoverBlock: leftover.has(night),
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
    leftoverNights: [...leftover],
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

function feeAmountText(cleaningFee) {
  const fee = cleaningFee?.amount;
  if (fee != null && !Number.isNaN(Number(fee))) return `$${Number(fee)}`;
  return 'our standard cleaning fee';
}

export function buildHeFeeThanksLine(cleaningFee, stayRange) {
  const feeText = feeAmountText(cleaningFee);
  return (
    `thanks for confirming the ${feeText} cleaning fee is fine` +
    (stayRange ? ` for ${stayRange}` : '')
  );
}

export function buildHomeExchangeFollowupDraft({
  guestName,
  checkIn,
  checkOut,
  originalCheckIn,
  originalCheckOut,
  calendar,
  cleaningFee,
  feeAccepted,
  askedDates,
  shouldThankForFee,
} = {}) {
  const name = (guestName || 'there').split(/\s+/)[0];
  const askedRange = askedDates ? formatStayRange(askedDates.checkIn, askedDates.checkOut) : formatStayRange(checkIn, checkOut);
  const originalRange = formatStayRange(originalCheckIn, originalCheckOut);
  const feeText = feeAmountText(cleaningFee);
  const thankFee =
    shouldThankForFee != null ? !!shouldThankForFee : !!feeAccepted;
  const feeThanks = thankFee ? buildHeFeeThanksLine(cleaningFee, originalRange) : null;

  if (!askedDates && !feeAccepted) {
    return {
      typeOfMessageReceived: 'HOMEEXCHANGE_FOLLOWUP',
      shouldReply: false,
      proposedResponse: null,
      reason: 'homeexchange_followup_no_dates',
    };
  }

  if (!askedDates && feeAccepted) {
    return {
      typeOfMessageReceived: 'HOMEEXCHANGE_FOLLOWUP',
      shouldReply: true,
      proposedResponse: buildPreapproveGuestMessage({
        guestName: name,
        feeThanks,
        originalRange,
      }),
      reason: 'homeexchange_followup_fee_accepted',
    };
  }

  if (!calendar?.checked) {
    return {
      typeOfMessageReceived: 'HOMEEXCHANGE_FOLLOWUP',
      shouldReply: true,
      proposedResponse:
        `Hi ${name}` +
        (feeThanks ? ` — ${feeThanks}.` : ',') +
        `\n\nI'm checking` +
        (askedRange ? ` ${askedRange}` : ' those dates') +
        ` and will follow up shortly on whether that window is open.`,
      reason: 'homeexchange_followup_calendar_not_checked',
    };
  }

  if (!calendar.open) {
    return {
      typeOfMessageReceived: 'HOMEEXCHANGE_FOLLOWUP',
      shouldReply: true,
      proposedResponse:
        `Hi ${name}` +
        (feeThanks ? ` — ${feeThanks}.` : ',') +
        `\n\nI checked` +
        (askedRange ? ` ${askedRange}` : '') +
        ` and those dates are not open on our calendar.`,
      reason: 'homeexchange_followup_calendar_not_open',
    };
  }

  return {
    typeOfMessageReceived: 'HOMEEXCHANGE_FOLLOWUP',
    shouldReply: true,
    proposedResponse:
      `Hi ${name}` +
      (feeThanks ? ` — ${feeThanks}.` : ',') +
      `\n\nI checked` +
      (askedRange ? ` ${askedRange}` : '') +
      `: those dates are also open. The same ${feeText} cleaning fee after you leave would apply to that stay as well. Would you like us to hold that one too?`,
    reason: 'homeexchange_followup_calendar_open',
  };
}

function firstHeDraft({
  guestName,
  guestMessage,
  reason,
  policySentence,
  extraParagraph,
} = {}) {
  const ackClause = buildHeFirstAckClause(guestMessage);
  return {
    typeOfMessageReceived: 'HOMEEXCHANGE_FIRST_MESSAGE',
    shouldReply: true,
    ackClause,
    ackSource: 'hooks',
    policySentence,
    extraParagraph: extraParagraph || null,
    proposedResponse: composeHeFirstReply({
      guestName,
      ackClause,
      policySentence,
      extraParagraph,
    }),
    reason,
  };
}

export function buildHomeExchangeDraft({
  guestName,
  guestMessage,
  checkIn,
  checkOut,
  originalCheckIn,
  originalCheckOut,
  calendar,
  cleaningFee,
  isFirst,
  feeAccepted,
  askedDates,
  shouldThankForFee,
} = {}) {
  const range = formatStayRange(checkIn, checkOut);

  if (!isFirst) {
    return buildHomeExchangeFollowupDraft({
      guestName,
      checkIn,
      checkOut,
      originalCheckIn,
      originalCheckOut,
      calendar,
      cleaningFee,
      feeAccepted,
      askedDates,
      shouldThankForFee,
    });
  }

  if (!calendar?.checked) {
    return firstHeDraft({
      guestName,
      guestMessage,
      reason: 'calendar_not_checked',
      policySentence:
        "I'm checking whether those dates are open on our calendar and will follow up shortly about the stay and the cleaning fee.",
    });
  }

  if (!calendar.open) {
    const blocked = (calendar.unavailable || []).join(', ');
    return firstHeDraft({
      guestName,
      guestMessage,
      reason: 'calendar_not_open',
      policySentence:
        `I checked our calendar` +
        (range ? ` for ${range}` : '') +
        ` and those dates are not open, so we can't accept the request as it stands.` +
        (blocked ? ` Unavailable night(s): ${blocked}.` : ''),
    });
  }

  const feeText = feeAmountText(cleaningFee);

  return firstHeDraft({
    guestName,
    guestMessage,
    reason: 'calendar_open_ask_cleaning_fee',
    policySentence: range
      ? `${range} is open on our calendar, so we can accept the request.`
      : 'Those dates are open on our calendar, so we can accept the request.',
    extraParagraph:
      `One thing we ask for Home Exchange stays: the cleaning fee after you leave is ${feeText}. ` +
      `Would you be okay paying that after your stay?`,
  });
}

function buildPreapproveGuestMessage({
  guestName,
  feeThanks,
  originalRange,
  extraParagraph,
  extraNightNote,
} = {}) {
  const name = (guestName || 'there').split(/\s+/)[0];
  let text = `Hi ${name}`;
  if (feeThanks) text += ` — ${feeThanks}.`;
  else text += '.';
  if (extraNightNote) text += ` ${extraNightNote}`;
  text +=
    ` I just sent you a pre-approval` +
    (originalRange ? ` for ${originalRange}` : '') +
    ` and blocked those dates for you.`;
  if (extraParagraph) text += `\n\n${extraParagraph}`;
  return text;
}

export function buildHeExtraNightDraft({
  guestName,
  extraNights = [],
  extraNightsOpen,
  stayRange,
  extraNightChecked,
} = {}) {
  const name = (guestName || 'there').split(/\s+/)[0];
  const extraLabel = formatNightList(extraNights) || 'that extra night';
  const nightWord = extraNights.length === 1 ? 'night' : 'nights';
  if (!extraNightChecked) {
    return {
      typeOfMessageReceived: 'HOMEEXCHANGE_FOLLOWUP',
      shouldReply: true,
      proposedResponse:
        `Hi ${name} — I'm checking the extra ${nightWord} of ${extraLabel} and will follow up shortly.`,
      reason: 'homeexchange_extra_night_calendar_not_checked',
    };
  }
  if (extraNightsOpen === false) {
    return {
      typeOfMessageReceived: 'HOMEEXCHANGE_FOLLOWUP',
      shouldReply: true,
      proposedResponse:
        `Hi ${name} — I checked the extra ${nightWord} of ${extraLabel} and ` +
        `that ${nightWord} ${extraNights.length === 1 ? 'is' : 'are'} not open on our calendar, ` +
        `so I can't hold the longer stay.`,
      reason: 'homeexchange_extra_night_not_open',
    };
  }
  return {
    typeOfMessageReceived: 'HOMEEXCHANGE_FOLLOWUP',
    shouldReply: true,
    proposedResponse:
      `Hi ${name} — I checked the extra ${nightWord} of ${extraLabel} and ` +
      `that ${nightWord} ${extraNights.length === 1 ? 'is' : 'are'} open. ` +
      (stayRange
        ? `Update the request on HomeExchange to ${stayRange} and I'll send a new pre-approval.`
        : `Update the request on HomeExchange for those dates and I'll send a new pre-approval.`),
    reason: 'homeexchange_extra_night_open',
  };
}

export function buildHeFinalizeThankYouDraft({ guestName, checkIn, checkOut } = {}) {
  const name = (guestName || '').trim().split(/\s+/)[0] || 'there';
  const range = formatStayRange(checkIn, checkOut);
  return {
    typeOfMessageReceived: 'HOMEEXCHANGE_EXCHANGE_FINALIZED',
    shouldReply: true,
    proposedResponse: range
      ? `Thank you for confirming, ${name}! We're looking forward to hosting you ${range}.`
      : `Thank you for confirming, ${name}! We're looking forward to hosting you.`,
    reason: 'homeexchange_exchange_finalized',
  };
}

export function extraNightNoteText(extraNights = [], extraNightsOpen) {
  if (!extraNights.length || extraNightsOpen !== true) return null;
  const extraLabel = formatNightList(extraNights);
  const nightWord = extraNights.length === 1 ? 'night' : 'nights';
  const verb = extraNights.length === 1 ? 'is' : 'are';
  return extraLabel
    ? `I checked the extra ${nightWord} of ${extraLabel} and that ${nightWord} ${verb} open.`
    : `I checked the extra ${nightWord} and ${verb} open.`;
}

const HE_DRAFT_NO_SEND = new Set([
  'calendar_not_checked',
  'homeexchange_followup_calendar_not_checked',
  'homeexchange_extra_night_calendar_not_checked',
  // Only send the pre-approval note after we actually pre-approved + blocked.
  'homeexchange_followup_fee_accepted',
  'homeexchange_preapprove_already_approved',
  'homeexchange_preapprove_block_failed',
  'homeexchange_preapprove_approve_failed',
]);

export function shouldSendHomeExchangeDraft(draft, _isFirst) {
  if (!draft?.shouldReply) return false;
  if (!draft?.proposedResponse || draft.proposedResponse === 'none') return false;
  if (HE_DRAFT_NO_SEND.has(draft.reason)) return false;
  if (isAirbnbOnlyHeCategory(draft.typeOfMessageReceived)) return false;
  return true;
}

export function shouldAttemptPreapprove({
  isFirst,
  feeAccepted,
  originalCheckIn,
  originalCheckOut,
  originalCalendar,
  checkIn,
  checkOut,
  calendar,
  thisTurnWantsPreapprove,
  extraNights,
  extraNightsOpen,
} = {}) {
  if (isFirst) return false;
  if (!feeAccepted) return false;
  // Thank-you / wifi / checkout after a prior fee-accept must not re-run pre-approve.
  if (thisTurnWantsPreapprove === false) return false;
  const stayIn = checkIn || originalCheckIn;
  const stayOut = checkOut || originalCheckOut;
  const cal = calendar || originalCalendar;
  if (!stayIn || !stayOut) return false;
  if (Array.isArray(extraNights) && extraNights.length > 0 && extraNightsOpen === false) {
    return false;
  }
  return !!(cal?.checked && cal?.open);
}

async function loadHospitableWindow(hospitableClient, propertyId, checkIn, checkOut) {
  let calendarDays = [];
  let reservations = [];
  let calendarError = null;
  let reservationsError = null;
  if (!hospitableClient || !checkIn || !checkOut) {
    return { calendarDays, reservations, calendarError, reservationsError };
  }
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
  return { calendarDays, reservations, calendarError, reservationsError };
}

async function loadHeCalendar(homeExchangeClient, homeId) {
  if (!homeExchangeClient || typeof homeExchangeClient.getHomeCalendar !== 'function' || !homeId) {
    return { ranges: null, error: null, fetched: false };
  }
  try {
    const ranges = await homeExchangeClient.getHomeCalendar(homeId);
    return { ranges: Array.isArray(ranges) ? ranges : [], error: null, fetched: true };
  } catch (err) {
    return { ranges: null, error: err?.message || String(err), fetched: false };
  }
}

export async function handleHomeExchangeMessage({
  event,
  hospitableClient = null,
  ddbClient = null,
  homeExchangeClient = null,
  notifyOwner = null,
  blockStore = null,
  now = new Date(),
  sharedCategoryAgent = null,
  sharedCategoryRunner = null,
  firstAckWriter = null,
} = {}) {
  const extracted = extractHomeExchangeMessage(event);
  const message = extracted.message;
  const context = extracted.context || {};
  const conversationId = context.conversation_id || context.conversationId || null;
  const providedHistory = Array.isArray(context.conversationHistory)
    ? context.conversationHistory
    : [];
  const loadedHistory = await loadHeConversationHistory({
    provided: providedHistory,
    conversationId,
    homeExchangeClient,
  });
  const conversationHistory = loadedHistory.conversationHistory;
  const contextCheckIn = dateOnly(context.checkIn || context.check_in);
  const contextCheckOut = dateOnly(context.checkOut || context.check_out);
  const guestFinalized = guestFinalizedHeExchange(message, context);
  const isFirst = guestFinalized
    ? false
    : isFirstHomeExchangeMessage(context, conversationHistory);
  const homeId = extractHeHomeId(context) || HE_HOME_ID;
  const unit = resolveHeUnit(homeId);
  const propertyId = unit.propertyId;
  const airbnbListingId = unit.airbnbListingId;
  const guestName = context.guestName || context.sender?.first_name || null;
  const feeAccepted =
    contextSaysCleaningFeeAccepted(context) ||
    guestAcceptedCleaningFeeInThread(message, conversationHistory, guestName);
  const alreadyThankedFee = hostAlreadyThankedCleaningFee(conversationHistory);
  const thankForFee = shouldThankForCleaningFee({
    feeAccepted,
    alreadyThanked: alreadyThankedFee,
  });
  const thisTurnWantsPreapprove = thisTurnWantsHePreapprove(message, {
    conversationHistory,
    eventType: context.eventType,
    action: context.action,
    act: context.act,
  });
  const cancelledPreapproval = threadHasCancelledPreapproval(conversationHistory);
  const resubmittedAfterCancel = guestResubmittedAfterHeCancel(message, conversationHistory);
  const priorPreapprovalStay = extractPriorPreapprovalStay(conversationHistory);

  let liveConversation = null;
  let liveExchange = null;
  if (!isFirst && conversationId && homeExchangeClient?.getConversation) {
    try {
      liveConversation = await homeExchangeClient.getConversation(conversationId);
      liveExchange = pickExchangeFromConversation(liveConversation, homeId);
    } catch {
      liveConversation = null;
      liveExchange = null;
    }
  }
  const exchangeCheckIn = dateOnly(liveExchange?.start_on || liveExchange?.startOn);
  const exchangeCheckOut = dateOnly(liveExchange?.end_on || liveExchange?.endOn);
  const askedDates = extractAskedStayDates(message, {
    now,
    originalCheckIn: priorPreapprovalStay?.checkIn || contextCheckIn,
    originalCheckOut: priorPreapprovalStay?.checkOut || contextCheckOut,
  });
  const stayWindows = resolveHeStayWindows({
    contextCheckIn,
    contextCheckOut,
    exchangeCheckIn,
    exchangeCheckOut,
    askedDates,
    priorPreapprovalStay,
  });
  const askedIsExtension = !!(
    askedDates &&
    isStayExtensionOf(
      stayWindows.previousCheckIn,
      stayWindows.previousCheckOut,
      askedDates.checkIn,
      askedDates.checkOut
    )
  );
  const exchangeIsExtension = isStayExtensionOf(
    stayWindows.previousCheckIn,
    stayWindows.previousCheckOut,
    exchangeCheckIn,
    exchangeCheckOut
  );
  const isExtension = askedIsExtension || exchangeIsExtension;
  const leftoverNights =
    isExtension || cancelledPreapproval
      ? stayNights(stayWindows.previousCheckIn, stayWindows.previousCheckOut)
      : [];

  const originalCheckIn = contextCheckIn;
  const originalCheckOut = contextCheckOut;
  let checkIn = originalCheckIn;
  let checkOut = originalCheckOut;
  if (!isFirst) {
    if (isExtension) {
      checkIn = exchangeIsExtension
        ? exchangeCheckIn
        : askedDates?.checkIn || stayWindows.targetCheckIn;
      checkOut = exchangeIsExtension
        ? exchangeCheckOut
        : askedDates?.checkOut || stayWindows.targetCheckOut;
    } else if (askedDates?.checkIn) {
      checkIn = askedDates.checkIn;
      checkOut = askedDates.checkOut;
    } else if (resubmittedAfterCancel && stayWindows.targetCheckIn) {
      checkIn = stayWindows.targetCheckIn;
      checkOut = stayWindows.targetCheckOut;
    }
  }
  const extraNights =
    isExtension || resubmittedAfterCancel
      ? extraNightsOf(
          stayWindows.previousCheckIn,
          stayWindows.previousCheckOut,
          checkIn,
          checkOut
        )
      : [];
  const approveCheckIn = isExtension || resubmittedAfterCancel ? checkIn : originalCheckIn;
  const approveCheckOut = isExtension || resubmittedAfterCancel ? checkOut : originalCheckOut;

  const shouldCheckCalendar = !!(
    !guestFinalized &&
    checkIn &&
    checkOut &&
    hospitableClient &&
    (isFirst || askedDates || feeAccepted || thisTurnWantsPreapprove || isExtension || cancelledPreapproval)
  );
  const hospitableWindow = shouldCheckCalendar
    ? await loadHospitableWindow(hospitableClient, propertyId, checkIn, checkOut)
    : { calendarDays: [], reservations: [], calendarError: null, reservationsError: null };

  const heCalRaw = (!guestFinalized && (isFirst || askedDates || feeAccepted || thisTurnWantsPreapprove || isExtension || cancelledPreapproval))
    ? await loadHeCalendar(homeExchangeClient, homeId)
    : { ranges: null, error: null, fetched: false };

  const hospitable = analyzeCalendarOpen({
    calendarDays: hospitableWindow.calendarDays,
    reservations: hospitableWindow.reservations,
    checkIn,
    checkOut,
    leftoverNights,
  });
  const heForDraft = heCalRaw.fetched
    ? analyzeHeCalendarOpen({ ranges: heCalRaw.ranges, checkIn, checkOut, leftoverNights })
    : { checked: false, open: false, unavailable: [], reason: 'he_calendar_not_fetched' };
  const calendar = shouldCheckCalendar
    ? mergeStayCalendars(hospitable, heForDraft)
    : hospitable;

  const extraNightsOpen =
    extraNights.length > 0 && calendar?.checked
      ? extraNights.every((night) => (calendar.available || []).includes(night))
      : extraNights.length === 0
        ? null
        : false;

  let originalHospitable = hospitable;
  let originalHe = heForDraft;
  let originalCalendar = calendar;
  const originalDiffers =
    !!(originalCheckIn && originalCheckOut) &&
    (originalCheckIn !== checkIn || originalCheckOut !== checkOut);
  if (feeAccepted && originalDiffers && hospitableClient && !isExtension && !resubmittedAfterCancel) {
    const origWin = await loadHospitableWindow(
      hospitableClient,
      propertyId,
      originalCheckIn,
      originalCheckOut
    );
    originalHospitable = analyzeCalendarOpen({
      calendarDays: origWin.calendarDays,
      reservations: origWin.reservations,
      checkIn: originalCheckIn,
      checkOut: originalCheckOut,
    });
    originalHe = heCalRaw.fetched
      ? analyzeHeCalendarOpen({
          ranges: heCalRaw.ranges,
          checkIn: originalCheckIn,
          checkOut: originalCheckOut,
        })
      : { checked: false, open: false, unavailable: [], reason: 'he_calendar_not_fetched' };
    originalCalendar = mergeStayCalendars(originalHospitable, originalHe);
  } else if (isExtension || resubmittedAfterCancel) {
    originalCalendar = calendar;
  }

  let cleaningFee = {
    amount: DEFAULT_CLEANING_FEES[airbnbListingId] ?? 125,
    source: 'default',
    listingId: airbnbListingId,
  };
  if ((isFirst && calendar.open) || (!isFirst && (feeAccepted || calendar.open || askedDates))) {
    cleaningFee = await loadCleaningFeeFromDdb(ddbClient, airbnbListingId);
  }

  let draft = buildHomeExchangeDraft({
    guestName,
    guestMessage: message,
    checkIn,
    checkOut,
    originalCheckIn,
    originalCheckOut,
    calendar,
    cleaningFee,
    isFirst,
    feeAccepted,
    askedDates,
    shouldThankForFee: thankForFee,
  });
  if (isFirst) {
    draft = await applyHeFirstAckWriter(draft, {
      message,
      guestName,
      writer: firstAckWriter,
    });
  }

  const store = blockStore || createDdbBlockStore(ddbClient);
  let preapprove = {
    attempted: false,
    ok: false,
    reason: null,
    exchangeId: null,
    nights: stayNights(approveCheckIn, approveCheckOut),
  };

  if ((isExtension || resubmittedAfterCancel) && extraNights.length > 0) {
    draft = buildHeExtraNightDraft({
      guestName,
      extraNights,
      extraNightsOpen,
      stayRange: formatStayRange(checkIn, checkOut),
      extraNightChecked: calendar?.checked === true,
    });
  }

  const exchangeMatchesApprove =
    !!approveCheckIn &&
    !!approveCheckOut &&
    exchangeCheckIn === approveCheckIn &&
    exchangeCheckOut === approveCheckOut;
  const alreadyApproved = !!(liveExchange && exchangeAlreadyApproved(liveExchange, liveConversation));
  const canApproveExtendedStay =
    (isExtension || resubmittedAfterCancel) &&
    extraNightsOpen !== false &&
    calendar?.open &&
    exchangeMatchesApprove &&
    !alreadyApproved;

  if (
    shouldAttemptPreapprove({
      isFirst,
      feeAccepted,
      originalCheckIn: approveCheckIn,
      originalCheckOut: approveCheckOut,
      originalCalendar: isExtension || resubmittedAfterCancel ? calendar : originalCalendar,
      checkIn: approveCheckIn,
      checkOut: approveCheckOut,
      calendar: isExtension || resubmittedAfterCancel ? calendar : originalCalendar,
      thisTurnWantsPreapprove,
      extraNights,
      extraNightsOpen,
    }) &&
    (!(isExtension || resubmittedAfterCancel) || canApproveExtendedStay)
  ) {
    preapprove = await runHomeExchangePreapprove({
      homeExchangeClient,
      hospitableClient,
      store,
      notifyOwner,
      conversationId,
      homeId,
      propertyId,
      guestName,
      propertyName: unit.propertyName,
      airbnbListingId,
      checkIn: approveCheckIn,
      checkOut: approveCheckOut,
      now,
      cleaningFeeAccepted: feeAccepted,
    });
  }

  if (preapprove.ok) {
    const approvedRange = formatStayRange(approveCheckIn, approveCheckOut);
    const feeText = feeAmountText(cleaningFee);
    const feeThanks = thankForFee ? buildHeFeeThanksLine(cleaningFee, approvedRange) : null;
    let extraParagraph = null;
    if (askedDates && calendar?.checked && !isExtension && !resubmittedAfterCancel) {
      const askedRange = formatStayRange(askedDates.checkIn, askedDates.checkOut);
      extraParagraph = calendar.open
        ? `I checked ${askedRange}: those dates are also open. The same ${feeText} cleaning fee after you leave would apply to that stay as well. Would you like us to hold that one too?`
        : `I checked ${askedRange} and those dates are not open on our calendar.`;
    }
    draft.shouldReply = true;
    draft.reason = 'homeexchange_preapproved';
    draft.proposedResponse = buildPreapproveGuestMessage({
      guestName,
      feeThanks,
      originalRange: approvedRange,
      extraParagraph,
      extraNightNote: extraNightNoteText(extraNights, extraNightsOpen),
    });
  }

  const heReservation = buildHeReservationContext({
    conversationId,
    exchange: liveExchange,
    guestName,
    checkIn: approveCheckIn || originalCheckIn || checkIn,
    checkOut: approveCheckOut || originalCheckOut || checkOut,
    homeId,
    propertyName: unit.propertyName,
    airbnbListingId,
    cleaningFee,
    cleaningFeeAccepted: feeAccepted,
    cleaningFeeThanked: alreadyThankedFee,
  });

  if (guestFinalized) {
    draft = buildHeFinalizeThankYouDraft({
      guestName,
      checkIn: exchangeCheckIn || checkIn || originalCheckIn,
      checkOut: exchangeCheckOut || checkOut || originalCheckOut,
    });
  }

  let sendEnabled = shouldSendHomeExchangeDraft(draft, isFirst);
  let sent = false;
  let sendError = null;
  let sendSkipReason = null;
  if (
    shouldRunSharedHeCategories({
      isFirst,
      heDraftSendable: sendEnabled,
      preapproveOk: !!preapprove.ok,
      thisTurnWantsPreapprove,
    })
  ) {
    try {
      const shared = await runSharedHeCategories({
        message,
        guestName,
        checkIn: originalCheckIn || checkIn,
        checkOut: originalCheckOut || checkOut,
        conversationId,
        conversationHistory,
        listingId: propertyId,
        propertyName: context.propertyName || APT3_PROPERTY_NAME,
        cleaningFeeAccepted: feeAccepted,
        reservation: heReservation,
        sharedCategoryAgent,
        sharedCategoryRunner,
      });
      if (shared) {
        draft.typeOfMessageReceived = shared.typeOfMessageReceived;
        draft.shouldReply = shared.shouldReply;
        draft.proposedResponse = shared.proposedResponse;
        draft.reason = shared.reason;
        draft.sharedCategory = true;
        sendEnabled = shouldSendHomeExchangeDraft(draft, isFirst);
      }
    } catch (err) {
      draft.reason = 'homeexchange_shared_agent_failed';
      sendError = err?.message || String(err);
    }
  }

  if (sendEnabled && homeExchangeClient && typeof homeExchangeClient.sendMessage === 'function') {
    if (!conversationId) {
      sendError = 'missing_conversation_id';
    } else {
      try {
        if (typeof homeExchangeClient.listMessages === 'function') {
          const existing = await homeExchangeClient.listMessages(conversationId);
          if (alreadySentEquivalent(existing, draft.proposedResponse)) {
            sendSkipReason = 'already_sent';
          }
        }
        if (!sendSkipReason) {
          await homeExchangeClient.sendMessage(conversationId, draft.proposedResponse);
          sent = true;
        }
      } catch (err) {
        sendError = err?.message || String(err);
      }
    }
  } else if (sendEnabled && !homeExchangeClient) {
    sendSkipReason = 'no_homeexchange_client';
  } else if (!sendEnabled) {
    sendSkipReason = draft.reason || 'send_not_enabled';
  }

  const notifyPayload = {
    guestName,
    checkIn: approveCheckIn || originalCheckIn || checkIn,
    checkOut: approveCheckOut || originalCheckOut || checkOut,
    conversationId,
    exchangeId: preapprove.exchangeId,
    proposedResponse: draft.proposedResponse,
    reason: draft.reason,
    preapproved: !!preapprove.ok,
    propertyName: unit.propertyName,
    listingId: airbnbListingId,
    homeId,
  };
  if (sent && thankForFee) {
    heReservation.cleaningFeeThanked = true;
  }
  if (sent) {
    try {
      await notifyHeAutoReply(notifyOwner, { kind: 'sent', ...notifyPayload });
    } catch (notifyErr) {
      console.error('[HomeExchange] FCM sent notify failed', notifyErr?.message || notifyErr);
    }
  } else if (sendError) {
    try {
      await notifyHeAutoReply(notifyOwner, {
        kind: 'send_failed',
        ...notifyPayload,
        error: sendError,
      });
    } catch (notifyErr) {
      console.error('[HomeExchange] FCM send-fail notify failed', notifyErr?.message || notifyErr);
    }
  }

  return {
    platform: HOMEEXCHANGE_PLATFORM,
    sendDisabled: !sendEnabled,
    sent,
    sendError,
    sendSkipReason,
    conversationId,
    isFirstMessage: isFirst,
    guestFinalized,
    guestMessage: message,
    guestName,
    checkIn,
    checkOut,
    originalCheckIn,
    originalCheckOut,
    askedDates,
    extraNights,
    extraNightsOpen,
    leftoverNights,
    isExtension,
    cancelledPreapproval,
    feeAccepted,
    alreadyThankedFee,
    heReservation,
    historyFetched: loadedHistory.historyFetched,
    historyError: loadedHistory.historyError,
    propertyId,
    airbnbListingId,
    homeId,
    calendar,
    originalCalendar,
    heCalendarError: heCalRaw.error,
    cleaningFee,
    calendarError: hospitableWindow.calendarError,
    reservationsError: hospitableWindow.reservationsError,
    preapprove,
    typeOfMessageReceived: draft.typeOfMessageReceived,
    shouldReply: draft.shouldReply,
    proposedResponse: draft.proposedResponse,
    reason: draft.reason,
    escalated: false,
  };
}

export async function runHomeExchangePreapprove({
  homeExchangeClient,
  hospitableClient,
  store,
  notifyOwner,
  conversationId,
  homeId,
  propertyId,
  guestName,
  propertyName,
  airbnbListingId,
  checkIn,
  checkOut,
  now = new Date(),
  cleaningFeeAccepted = false,
} = {}) {
  const nights = stayNights(checkIn, checkOut);
  const base = {
    attempted: true,
    ok: false,
    reason: null,
    exchangeId: null,
    nights,
  };
  const unitNotify = {
    guestName,
    checkIn,
    checkOut,
    conversationId,
    propertyName,
    listingId: airbnbListingId,
    homeId,
  };

  const canApprove =
    typeof homeExchangeClient?.approveConversation === 'function' ||
    typeof homeExchangeClient?.approveExchange === 'function';
  if (!conversationId || !homeExchangeClient?.getConversation || !canApprove) {
    await notifyHePreapproval(notifyOwner, {
      kind: 'error',
      ...unitNotify,
      error: 'Missing HomeExchange client or conversation id — did not pre-approve.',
    });
    return base;
  }

  let exchange;
  let conv = null;
  try {
    conv = await homeExchangeClient.getConversation(conversationId);
    exchange = pickExchangeFromConversation(conv, homeId);
  } catch (err) {
    base.reason = 'he_conversation_failed';
    await notifyHePreapproval(notifyOwner, {
      kind: 'error',
      ...unitNotify,
      error: `Could not load HE conversation: ${err?.message || err}`,
    });
    return base;
  }

  if (!exchange?.id) {
    base.reason = 'missing_exchange';
    await notifyHePreapproval(notifyOwner, {
      kind: 'error',
      ...unitNotify,
      error: 'No HE exchange on the conversation — did not pre-approve.',
    });
    return base;
  }
  base.exchangeId = exchange.id;

  if (exchange.finalized_at) {
    base.reason = 'already_approved';
    await notifyHePreapproval(notifyOwner, {
      kind: 'error',
      ...unitNotify,
      exchangeId: exchange.id,
      error: 'HE exchange already finalized — did not proceed.',
    });
    return base;
  }

  if (!exchangeAlreadyApproved(exchange, conv)) {
    try {
      if (typeof homeExchangeClient.approveConversation === 'function') {
        await homeExchangeClient.approveConversation(conversationId);
      } else {
        await homeExchangeClient.approveExchange(exchange.id, { conversationId });
      }
    } catch (err) {
      console.error('[HomeExchange] pre-approve failed', err?.message || err);
      base.reason = 'approve_failed';
      await notifyHePreapproval(notifyOwner, {
        kind: 'error',
        ...unitNotify,
        exchangeId: exchange.id,
        error: `HE pre-approve failed: ${err?.message || err}`,
      });
      return base;
    }
  }

  try {
    if (!hospitableClient?.updatePropertyCalendar) {
      throw new Error('Hospitable calendar write client missing');
    }
    await hospitableClient.updatePropertyCalendar(
      propertyId,
      nights.map((date) => ({ date, available: false }))
    );
  } catch (err) {
    base.reason = 'block_failed';
    await notifyHePreapproval(notifyOwner, {
      kind: 'error',
      ...unitNotify,
      exchangeId: exchange.id,
      error: `Hospitable block failed after HE pre-approve: ${err?.message || err}`,
    });
    return base;
  }

  if (store?.put) {
    try {
      await store.put(
        buildBlockRecord({
          exchangeId: exchange.id,
          conversationId,
          propertyId,
          homeId,
          guestName,
          checkIn,
          checkOut,
          nights,
          now,
          cleaningFeeAccepted,
        })
      );
    } catch (err) {
      base.reason = 'block_record_failed';
      await notifyHePreapproval(notifyOwner, {
        kind: 'error',
        ...unitNotify,
        exchangeId: exchange.id,
        error: `Blocked nights but failed to persist expire record: ${err?.message || err}`,
      });
      return { ...base, ok: true };
    }
  }

  await notifyHePreapproval(notifyOwner, {
    kind: 'ready',
    ...unitNotify,
    exchangeId: exchange.id,
    nights,
  });
  return { ...base, ok: true, reason: 'preapproved' };
}
