/**
 * Occupancy + routing for unit-ready / early check-in notices.
 *
 * Two producers enqueue act=early_checkin_notice on grok_message:
 *   - cleaningToRegister (action=cleaning.unit_ready): cleaner marked the
 *     unit done. Message today's check-in even when there is a same-day
 *     checkout (that is the turnover).
 *   - noon Lambda (action=noon.vacant_unit_ready, source=noon_vacant):
 *     EventBridge noon ET. Message today's check-in only when the unit was
 *     vacant last night (no checkout today on Airbnb or HE) and the listing
 *     is not in Dynamo uncleanedUnits.
 *
 * Isolated path — no Grok. Airbnb via Hospitable or HomeExchange, whichever
 * guest is actually arriving today. Send window: 8:00 AM ≤ now < 4:00 PM
 * America/New_York. Never after 4pm ET.
 */
import {
  dateOnly,
  guestFirstName,
  LISTING_1B,
  LISTING_APT2,
  LISTING_APT3,
  loadCurrentGuestsByListing,
  nyTodayAndHour,
  UNIT_BY_LISTING,
} from './keypadLockoutOccupancy.js';

export {
  dateOnly,
  guestFirstName,
  LISTING_1B,
  LISTING_APT2,
  LISTING_APT3,
  loadCurrentGuestsByListing,
  nyTodayAndHour,
  UNIT_BY_LISTING,
};

export const EARLY_CHECKIN_NOTICE_ACT = 'early_checkin_notice';
export const FCM_TYPE_EARLY_CHECKIN = 'early_checkin_guest_notice';
export const CLEANING_TABLE = 'cleaning';
export const UNCLEANED_TABLE = 'uncleanedUnits';
export const SEND_WINDOW_START_MINUTES = 8 * 60;
export const SEND_WINDOW_END_MINUTES = 16 * 60;
export const NOON_VACANT_SOURCE = 'noon_vacant';
export const NOON_VACANT_ACTION = 'noon.vacant_unit_ready';

export const UNIT_READY_TEMPLATE =
  'Hi {FirstName},\nWe are pleased to let you know that the unit is ready for you to check in now.';

export function nyClock(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hourNy = parseInt(get('hour') || '0', 10);
  const minuteNy = parseInt(get('minute') || '0', 10);
  const secondNy = parseInt(get('second') || '0', 10);
  return {
    today: `${get('year')}-${get('month')}-${get('day')}`,
    hourNy,
    minuteNy,
    secondNy,
    minutesOfDay: hourNy * 60 + minuteNy,
  };
}

/**
 * Inclusive 8:00 AM ET through exclusive 4:00 PM ET.
 * 3:59 PM sends; 4:00:00 PM and later do not.
 */
export function isWithinUnitReadySendWindow(now = new Date()) {
  const { minutesOfDay } = nyClock(now);
  return (
    minutesOfDay >= SEND_WINDOW_START_MINUTES && minutesOfDay < SEND_WINDOW_END_MINUTES
  );
}

export function unitReadySkipReason(now = new Date()) {
  if (isWithinUnitReadySendWindow(now)) return null;
  const { minutesOfDay } = nyClock(now);
  if (minutesOfDay >= SEND_WINDOW_END_MINUTES) return 'after_4pm_et';
  return 'before_8am_et';
}

export function guestDedupeKey(guest) {
  if (!guest) return '';
  return [
    guest.platform || '',
    guest.reservationId || guest.conversationId || guest.exchangeId || guest.guestName || '',
  ].join(':');
}

export function hasCheckoutToday(guests, today) {
  const day = dateOnly(today);
  if (!day) return false;
  return (Array.isArray(guests) ? guests : []).some((g) => {
    return dateOnly(g?.checkOut || g?.check_out) === day;
  });
}

export function isNoonVacantSource(value) {
  const raw = String(value || '').toLowerCase();
  return (
    raw === NOON_VACANT_SOURCE ||
    raw === 'noon' ||
    raw === NOON_VACANT_ACTION ||
    raw === 'noon_vacant_unit_ready' ||
    raw === 'vacant_overnight'
  );
}

export function pickNextCheckinGuests(guests, today) {
  const arriving = [];
  const seen = new Set();
  for (const g of Array.isArray(guests) ? guests : []) {
    if (dateOnly(g?.checkIn || g?.check_in) !== today) continue;
    const key = guestDedupeKey(g);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    arriving.push(g);
  }
  arriving.sort((a, b) => {
    const aKey = `${dateOnly(a.checkIn) || ''}|${a.platform === 'homeexchange' ? '1' : '0'}`;
    const bKey = `${dateOnly(b.checkIn) || ''}|${b.platform === 'homeexchange' ? '1' : '0'}`;
    return aKey.localeCompare(bKey);
  });
  return arriving;
}

export function decideUnitReadyRecipients(
  listingId,
  guestsByListing,
  today,
  now = new Date(),
  opts = {}
) {
  const windowReason = unitReadySkipReason(now);
  if (windowReason) {
    return { send: false, reason: windowReason, recipients: [] };
  }
  const lid = String(listingId || '').trim();
  if (!lid || !UNIT_BY_LISTING[lid]) {
    return { send: false, reason: 'unknown_listing', recipients: [] };
  }
  const guests = (guestsByListing && guestsByListing[lid]) || [];
  const recipients = pickNextCheckinGuests(guests, today).map((g) => ({
    ...g,
    listingId: g.listingId || lid,
    propertyName: g.propertyName || UNIT_BY_LISTING[lid]?.propertyName || '',
  }));
  if (!recipients.length) {
    return { send: false, reason: 'no_checkin_today', recipients: [] };
  }
  if (opts.requireVacantOvernight && opts.uncleaned) {
    return { send: false, reason: 'uncleaned_unit', recipients };
  }
  if (opts.requireVacantOvernight && hasCheckoutToday(guests, today)) {
    return { send: false, reason: 'checkout_today', recipients };
  }
  const platforms = [...new Set(recipients.map((r) => r.platform))];
  const reason =
    platforms.length > 1
      ? 'next_checkin_airbnb_and_he'
      : platforms[0] === 'homeexchange'
        ? 'next_checkin_he'
        : 'next_checkin_airbnb';
  return { send: true, reason, recipients };
}

export function fillUnitReadyTemplate(firstName) {
  const name = String(firstName || 'there').trim() || 'there';
  return UNIT_READY_TEMPLATE.replace(/\{FirstName\}/g, name);
}

export function alreadySentUnitReadyNotice(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.some((m) => {
    const text = String(m?.content || m?.body || m?.text || '').toLowerCase();
    return /unit is ready for you to check in now/.test(text);
  });
}

export function isEarlyCheckinNoticeAct(value) {
  const raw = String(value || '').toLowerCase();
  return (
    raw === EARLY_CHECKIN_NOTICE_ACT ||
    raw === 'cleaning.unit_ready' ||
    raw === 'early_checkin_after_cleaning' ||
    isNoonVacantSource(raw)
  );
}

export function isEarlyCheckinNoticeTurn(event = null) {
  const candidates = [event];
  if (typeof event?.Records?.[0]?.body === 'string') {
    try {
      candidates.push(JSON.parse(event.Records[0].body));
    } catch {
      /* ignore */
    }
  }
  if (typeof event?.body === 'string') {
    try {
      candidates.push(JSON.parse(event.body));
    } catch {
      /* ignore */
    }
  }
  for (const p of candidates) {
    if (!p || typeof p !== 'object') continue;
    const act = p?.queryStringParameters?.act || p?.act || p?.data?.act;
    if (isEarlyCheckinNoticeAct(act)) return true;
    if (isEarlyCheckinNoticeAct(p?.action) || isEarlyCheckinNoticeAct(p?.data?.action)) {
      return true;
    }
  }
  return false;
}

export function extractEarlyCheckinNoticeContext(event = null) {
  const blobs = [];
  if (event && typeof event === 'object') blobs.push(event);
  if (typeof event?.Records?.[0]?.body === 'string') {
    try {
      blobs.push(JSON.parse(event.Records[0].body));
    } catch {
      /* ignore */
    }
  }
  if (typeof event?.body === 'string') {
    try {
      blobs.push(JSON.parse(event.body));
    } catch {
      /* ignore */
    }
  }
  let data = {};
  let action = '';
  for (const p of blobs) {
    if (p?.data && typeof p.data === 'object') {
      data = { ...data, ...p.data };
    }
    if (p?.listingId || p?.listingName) {
      data = { ...data, ...p };
    }
    if (typeof p?.action === 'string' && p.action) action = p.action;
  }
  const simulate = data.simulate === true || data.simulate === 'true' || data.simulate === 1;
  const sendGuestsRaw = data.sendGuests;
  const sendGuests =
    !simulate && sendGuestsRaw !== false && sendGuestsRaw !== 'false' && sendGuestsRaw !== 0;
  const listingId = String(data.listingId || '').trim();
  const unit = UNIT_BY_LISTING[listingId] || null;
  const sourceRaw = data.source || data.origin || action || '';
  const requireVacantOvernight = isNoonVacantSource(sourceRaw);
  return {
    listingId,
    listingName: data.listingName || unit?.propertyName || '',
    date: dateOnly(data.date) || '',
    eventAt: data.eventAt || '',
    instruction: data.instruction || '',
    source: requireVacantOvernight ? NOON_VACANT_SOURCE : 'cleaning',
    requireVacantOvernight,
    simulate,
    sendGuests,
  };
}

export function buildEarlyCheckinGuestNotify({
  simulate,
  decision,
  recipients,
  listingId,
  listingName,
  proposedResponse,
  sent,
  sentCount,
  sendError,
  sendSkipReason,
} = {}) {
  const list = Array.isArray(recipients) ? recipients : [];
  const first = list[0] || null;
  const guest = first ? guestFirstName(first) : 'guest';
  const unit =
    listingName ||
    first?.propertyName ||
    UNIT_BY_LISTING[String(listingId || '')]?.propertyName ||
    'Pine';
  const platforms = [
    ...new Set(
      list.map((r) => (r.platform === 'homeexchange' ? 'Home Exchange' : 'Airbnb'))
    ),
  ];
  const platformLabel = platforms.join(' + ') || 'Airbnb / HE';
  const sim = simulate ? ' (sim)' : '';
  const data = {
    type: FCM_TYPE_EARLY_CHECKIN,
    listingId: String(listingId || first?.listingId || ''),
    listingName: String(unit),
    guestName: String(guest),
    platform: String(first?.platform || ''),
    reason: String(decision?.reason || sendSkipReason || ''),
    simulate: simulate ? 'true' : 'false',
    sent: sent ? 'true' : 'false',
    sentCount: String(sentCount || (sent ? 1 : 0)),
    color: '#2563EB',
  };

  if (sendError) {
    return {
      type: FCM_TYPE_EARLY_CHECKIN,
      title: `Unit-ready guest notice failed${sim}`,
      body: `${unit}: ${sendError}`.slice(0, 900),
      data: { ...data, error: String(sendError) },
    };
  }
  if (simulate && decision?.send && first) {
    return {
      type: FCM_TYPE_EARLY_CHECKIN,
      title: `Unit ready (sim) — ${guest}`,
      body: `Would message ${unit} via ${platformLabel} that the unit is ready to check in now. Guest send skipped (simulation).`,
      data,
    };
  }
  if (sent) {
    return {
      type: FCM_TYPE_EARLY_CHECKIN,
      title: `Unit ready — message sent to ${guest}`,
      body: `${unit} via ${platformLabel}. The unit is ready to check in now.`,
      data,
    };
  }
  if (decision?.reason === 'after_4pm_et' || sendSkipReason === 'after_4pm_et') {
    return {
      type: FCM_TYPE_EARLY_CHECKIN,
      title: `Unit-ready skipped — after 4pm ET${sim}`,
      body: `${unit}: at or after 4pm ET, so no early check-in message.`,
      data,
    };
  }
  if (decision?.reason === 'checkout_today' || sendSkipReason === 'checkout_today') {
    return {
      type: FCM_TYPE_EARLY_CHECKIN,
      title: `Unit-ready skipped — checkout today${sim}`,
      body: `${unit}: a guest is checking out today, so noon did not send "unit is ready".`,
      data,
    };
  }
  if (decision?.reason === 'uncleaned_unit' || sendSkipReason === 'uncleaned_unit') {
    return {
      type: FCM_TYPE_EARLY_CHECKIN,
      title: `Unit-ready skipped — not cleaned${sim}`,
      body: `${unit}: still in the uncleaned bucket, so noon did not send "unit is ready".`,
      data,
    };
  }
  if (decision?.reason === 'no_checkin_today' || sendSkipReason === 'no_checkin_today') {
    return {
      type: FCM_TYPE_EARLY_CHECKIN,
      title: `Unit-ready skipped — no check-in today${sim}`,
      body: `${unit}: no Airbnb or Home Exchange guest checking in today.`,
      data,
    };
  }
  return {
    type: FCM_TYPE_EARLY_CHECKIN,
    title: `Unit-ready guest notice skipped${sim}`,
    body: `${unit}: ${decision?.reason || sendSkipReason || 'no_recipient'}`.slice(0, 900),
    data,
  };
}
