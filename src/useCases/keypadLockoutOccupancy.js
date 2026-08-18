/**
 * Occupancy + routing for keypad-lockout guest notices.
 * Pure helpers are unit-tested; live fetch uses Hospitable + HomeExchange
 * clients (those already retry with exp backoff).
 */
export const KEYPAD_LOCKOUT_NOTICE_ACT = 'keypad_lockout_notice';
export const FCM_TYPE_LOCKOUT_GUEST = 'keypad_lockout_guest_notice';

export const LISTING_1B = '20904545';
export const LISTING_APT2 = '20150380';
export const LISTING_APT3 = '24259977';
export const BACKDOOR_LISTING_IDS = [LISTING_1B, LISTING_APT2];

export const UNIT_BY_LISTING = {
  [LISTING_1B]: {
    listingId: LISTING_1B,
    propertyId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
    propertyName: 'Pine Apt #1B',
    apt: '1B',
    heHomeId: '3285159',
  },
  [LISTING_APT2]: {
    listingId: LISTING_APT2,
    propertyId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
    propertyName: 'Pine Apt #2',
    apt: '2',
    heHomeId: '3285044',
  },
  [LISTING_APT3]: {
    listingId: LISTING_APT3,
    propertyId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
    propertyName: 'Pine Apt #3',
    apt: '3',
    heHomeId: '3202475',
  },
};

export const HE_HOME_TO_LISTING = {
  '3285159': LISTING_1B,
  '3285044': LISTING_APT2,
  '3202475': LISTING_APT3,
};

export const LOCK_PHRASES = {
  '1b': 'the Apt 1B door keypad',
  apt3: 'the Apt 3 apartment door keypad',
  'apt 2 front': 'the Apt 2 front door keypad',
  apt2back: 'the Apt 2 parking-side door keypad',
  backdoor: 'the shared building entrance keypad (parking side)',
};

export const LISTINGS_FOR_LOCK = {
  '1b': [LISTING_1B],
  apt3: [LISTING_APT3],
  'apt 2 front': [LISTING_APT2],
  apt2back: [LISTING_APT2],
  backdoor: BACKDOOR_LISTING_IDS,
  basement: [],
};

export const LOCK_KEYS = {
  '1b': '1b',
  apt3: 'apt3',
  'apt 2 front': 'apt2front',
  apt2back: 'apt2back',
  backdoor: 'backdoor',
  basement: 'basement',
};

export const GUEST_TEMPLATE = [
  'Hi {FirstName},',
  '',
  'A quick heads-up: {lockPhrase} just locked itself for about 1 to 5 minutes after a few unsuccessful code attempts. This is a safety feature on the lock — it is not broken, and your code has not changed.',
  '',
  'Please wait 1 to 5 minutes, then try your code again (the last 4 digits of the phone number on your reservation). Please do not try extra codes while it is paused — that can restart the timer.',
  '',
  'Sorry for the interruption. Reply here if you still cannot get in after waiting.',
  '',
  'Warm regards,',
  'Jerome',
  '',
].join('\n');

export function normalizeLockName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(' ');
}

export function dateOnly(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function nyTodayAndHour(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    today: `${get('year')}-${get('month')}-${get('day')}`,
    hourNy: parseInt(get('hour') || '0', 10),
  };
}

export function lockPhraseFor(lockName) {
  return LOCK_PHRASES[normalizeLockName(lockName)] || 'the door keypad';
}

export function listingsForLock(lockName) {
  return LISTINGS_FOR_LOCK[normalizeLockName(lockName)] || [];
}

export function lockKeyFor(lockName) {
  const n = normalizeLockName(lockName);
  if (LOCK_KEYS[n]) return LOCK_KEYS[n];
  return n.replace(/\s+/g, '') || 'unknown';
}

export function isStayCurrent(checkIn, checkOut, today, hourNy) {
  const ci = dateOnly(checkIn);
  const co = dateOnly(checkOut);
  if (!ci || !co || !today) return false;
  if (ci > today) return false;
  if (co > today) return true;
  if (co === today) return Number(hourNy) < 10;
  return false;
}

export function pickCurrentGuest(guests, today, hourNy) {
  const current = (Array.isArray(guests) ? guests : []).filter((g) =>
    isStayCurrent(g?.checkIn || g?.check_in, g?.checkOut || g?.check_out, today, hourNy)
  );
  if (!current.length) return null;
  if (current.length === 1) return current[0];
  const departing = current.filter((g) => dateOnly(g.checkOut || g.check_out) === today);
  const arriving = current.filter((g) => dateOnly(g.checkIn || g.check_in) === today);
  if (Number(hourNy) < 10 && departing.length) return departing[0];
  if (arriving.length) return arriving[0];
  return current[current.length - 1];
}

export function decideLockoutRecipients(lockName, guestsByListing, today, hourNy) {
  const listings = listingsForLock(lockName);
  const occupied = [];
  for (const lid of listings) {
    const guest = pickCurrentGuest((guestsByListing && guestsByListing[lid]) || [], today, hourNy);
    if (guest) occupied.push({ ...guest, listingId: guest.listingId || lid });
  }
  const n = normalizeLockName(lockName);
  if (n === 'backdoor') {
    if (occupied.length === 1) {
      return { send: true, reason: 'backdoor_single_unit_occupied', recipients: occupied };
    }
    if (occupied.length >= 2) {
      return { send: false, reason: 'backdoor_both_occupied', recipients: [] };
    }
    return { send: false, reason: 'backdoor_neither_occupied', recipients: [] };
  }
  if (!listings.length) {
    return { send: false, reason: 'lock_not_messageable', recipients: [] };
  }
  if (!occupied.length) {
    return { send: false, reason: 'unit_vacant', recipients: [] };
  }
  return { send: true, reason: 'unit_occupied', recipients: occupied };
}

export function fillGuestTemplate(firstName, lockName) {
  const name = String(firstName || 'there').trim() || 'there';
  return GUEST_TEMPLATE.replace(/\{FirstName\}/g, name).replace(
    /\{lockPhrase\}/g,
    lockPhraseFor(lockName)
  );
}

export function alreadySentLockoutNotice(messages, lockPhrase) {
  const phrase = String(lockPhrase || '').toLowerCase();
  const list = Array.isArray(messages) ? messages : [];
  return list.some((m) => {
    const text = String(m?.content || m?.body || m?.text || '').toLowerCase();
    if (!text) return false;
    if (!/locked itself for about 1 to 5 minutes/.test(text)) return false;
    if (phrase && !text.includes(phrase)) return false;
    return true;
  });
}

export function guestFirstName(guest) {
  if (!guest) return 'there';
  const first = String(guest.firstName || guest.first_name || '').trim();
  if (first) return first;
  const full = String(guest.guestName || guest.full_name || guest.name || '').trim();
  if (full) return full.split(/\s+/)[0];
  return 'there';
}

export function isCancelledReservation(r) {
  const status = String(r?.status || '').toLowerCase();
  let cat = '';
  if (r?.reservation_status?.current) {
    cat = String(r.reservation_status.current.category || '').toLowerCase();
  }
  return (
    status.includes('cancel') ||
    cat.includes('cancel') ||
    status === 'declined' ||
    cat === 'declined' ||
    status === 'inquiry' ||
    cat === 'inquiry' ||
    cat === 'request' ||
    cat === 'not accepted'
  );
}

export function reservationPlatform(r) {
  const raw =
    r?.platform?.name ||
    r?.platform?.platform_name ||
    r?.platform ||
    r?.platform_name ||
    r?.listing?.platform ||
    '';
  const s = String(raw).toLowerCase();
  if (s.includes('homeexchange') || s.includes('home exchange')) return 'homeexchange';
  return 'hospitable';
}

export function listingIdFromReservation(r) {
  const props = Array.isArray(r?.properties) ? r.properties : [];
  for (const p of props) {
    const pid = p?.id != null ? String(p.id) : '';
    for (const [lid, meta] of Object.entries(UNIT_BY_LISTING)) {
      if (pid && pid === meta.propertyId) return lid;
    }
    const platId = p?.platform_id != null ? String(p.platform_id) : '';
    if (platId && UNIT_BY_LISTING[platId]) return platId;
  }
  const lid = r?.listingId || r?.airbnbListingId;
  if (lid && UNIT_BY_LISTING[String(lid)]) return String(lid);
  return null;
}

export function normalizeHospitableGuest(r) {
  if (!r || isCancelledReservation(r)) return null;
  const listingId = listingIdFromReservation(r);
  if (!listingId) return null;
  const platform = reservationPlatform(r);
  if (platform === 'homeexchange') return null;
  const guest = r.guest || {};
  const firstName = guestFirstName(guest);
  const conversationId = r.conversation_id || r.conversationId || null;
  const reservationId = r.id || r.reservation_id || r.reservationId || null;
  if (!reservationId && !conversationId) return null;
  return {
    listingId,
    firstName,
    guestName: [guest.first_name, guest.last_name].filter(Boolean).join(' ') || firstName,
    platform: 'hospitable',
    reservationId,
    conversationId,
    checkIn: dateOnly(r.check_in || r.arrival_date || r.checkIn),
    checkOut: dateOnly(r.check_out || r.departure_date || r.checkOut),
    propertyName: UNIT_BY_LISTING[listingId]?.propertyName || '',
  };
}

export function heHomeIdFromExchange(ex) {
  if (!ex) return null;
  if (ex.home?.id != null) return String(ex.home.id);
  if (ex.home_id != null) return String(ex.home_id);
  if (ex.home != null && typeof ex.home !== 'object') return String(ex.home);
  return null;
}

export function isFinalizedHeExchange(ex) {
  if (!ex || typeof ex !== 'object') return false;
  if (ex.canceleted_at || ex.canceled_at) return false;
  const st = ex.status;
  if (st === 5 || st === '5') return false;
  if (ex.finalized_at) return true;
  if (st === 3 || st === '3') return true;
  return false;
}

export function extractHeGuestsFromConversationNodes(nodes) {
  const out = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const conversationId = node?.id != null ? String(node.id) : null;
    const exchanges = Array.isArray(node?.exchanges)
      ? node.exchanges
      : Array.isArray(node?.all_exchanges)
        ? node.all_exchanges
        : [];
    for (const ex of exchanges) {
      if (!isFinalizedHeExchange(ex)) continue;
      const homeId = heHomeIdFromExchange(ex);
      const listingId = homeId ? HE_HOME_TO_LISTING[String(homeId)] : null;
      if (!listingId) continue;
      const guest = ex.guest || node.interlocutor || {};
      const firstName = guestFirstName(guest);
      out.push({
        listingId,
        firstName,
        guestName:
          [guest.first_name, guest.last_name].filter(Boolean).join(' ') || firstName,
        platform: 'homeexchange',
        reservationId: null,
        conversationId,
        exchangeId: ex.id != null ? String(ex.id) : null,
        homeId: String(homeId),
        checkIn: dateOnly(ex.start_on || ex.checkIn),
        checkOut: dateOnly(ex.end_on || ex.checkOut),
        propertyName: UNIT_BY_LISTING[listingId]?.propertyName || '',
      });
    }
  }
  return out;
}

export function mergeGuestsByListing(hospitableGuests, heGuests) {
  const by = { [LISTING_1B]: [], [LISTING_APT2]: [], [LISTING_APT3]: [] };
  for (const g of [...(heGuests || []), ...(hospitableGuests || [])]) {
    if (!g?.listingId || !by[g.listingId]) continue;
    by[g.listingId].push(g);
  }
  return by;
}

export function conversationNodesFromHeList(payload) {
  const data = payload?.data || payload || {};
  const conv = data.conversations || data;
  const edges = Array.isArray(conv?.edges) ? conv.edges : Array.isArray(conv) ? conv : [];
  return edges.map((edge) => edge?.node || edge || {}).filter((n) => n && n.id != null);
}

export async function loadCurrentGuestsByListing({
  hospitableClient,
  homeExchangeClient,
  now = new Date(),
} = {}) {
  const { today } = nyTodayAndHour(now);
  const start = addDaysYmd(today, -30);
  const end = addDaysYmd(today, 2);
  const propertyIds = Object.values(UNIT_BY_LISTING).map((u) => u.propertyId);

  const hospitableRows = hospitableClient?.getReservations
    ? await hospitableClient.getReservations({
        properties: propertyIds,
        per_page: 100,
        start_date: start,
        end_date: end,
        include: 'properties,guest',
      })
    : [];

  const hePayload = homeExchangeClient?.listConversations
    ? await homeExchangeClient.listConversations({ limit: 50 })
    : null;

  const hospitableGuests = (Array.isArray(hospitableRows) ? hospitableRows : [])
    .map(normalizeHospitableGuest)
    .filter(Boolean);
  const heGuests = extractHeGuestsFromConversationNodes(conversationNodesFromHeList(hePayload));
  return mergeGuestsByListing(hospitableGuests, heGuests);
}

function addDaysYmd(ymd, delta) {
  const [y, m, d] = String(ymd)
    .split('-')
    .map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

export function isKeypadLockoutNoticeAct(value) {
  const raw = String(value || '').toLowerCase();
  return (
    raw === KEYPAD_LOCKOUT_NOTICE_ACT ||
    raw === 'keypad.lockout.notice' ||
    raw === 'keypad_lockout'
  );
}

export function isKeypadLockoutNoticeTurn(event = null) {
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
    if (isKeypadLockoutNoticeAct(act)) return true;
    if (isKeypadLockoutNoticeAct(p?.action) || isKeypadLockoutNoticeAct(p?.data?.action)) {
      return true;
    }
  }
  return false;
}

export function extractLockoutNoticeContext(event = null) {
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
  for (const p of blobs) {
    if (p?.data && typeof p.data === 'object') {
      data = { ...data, ...p.data };
    }
    if (p?.lockName || p?.lockoutKey) {
      data = { ...data, ...p };
    }
  }
  const simulate = data.simulate === true || data.simulate === 'true' || data.simulate === 1;
  const sendGuestsRaw = data.sendGuests;
  const sendGuests =
    !simulate && sendGuestsRaw !== false && sendGuestsRaw !== 'false' && sendGuestsRaw !== 0;
  return {
    lockName: data.lockName || data.lock || '',
    lockLabel: data.lockLabel || data.lockName || '',
    lockKey: data.lockKey || lockKeyFor(data.lockName || data.lock),
    listingId: data.listingId || '',
    eventAt: data.eventAt || '',
    lockoutKey: data.lockoutKey || data.id || '',
    deviceId: data.deviceId || '',
    simulate,
    sendGuests,
    lockPhrase: data.lockPhrase || lockPhraseFor(data.lockName),
  };
}

export function buildLockoutGuestNotify({
  simulate,
  decision,
  recipient,
  lockName,
  proposedResponse,
  sent,
  sendError,
  sendSkipReason,
} = {}) {
  const label = lockPhraseFor(lockName);
  const name = recipient?.firstName || 'guest';
  const unit = recipient?.propertyName || recipient?.listingId || '';
  const platform = recipient?.platform === 'homeexchange' ? 'Home Exchange' : 'Airbnb';
  const sim = simulate ? ' (sim)' : '';
  const data = {
    type: FCM_TYPE_LOCKOUT_GUEST,
    lockName: String(lockName || ''),
    lockKey: lockKeyFor(lockName),
    listingId: String(recipient?.listingId || ''),
    listingName: String(unit),
    guestName: String(name),
    platform: String(recipient?.platform || ''),
    reason: String(decision?.reason || sendSkipReason || ''),
    simulate: simulate ? 'true' : 'false',
    sent: sent ? 'true' : 'false',
    color: '#DC2626',
  };

  if (sendError) {
    return {
      type: FCM_TYPE_LOCKOUT_GUEST,
      title: `Lockout guest notice failed${sim}`,
      body: `${label}: ${sendError}`.slice(0, 900),
      data: { ...data, error: String(sendError) },
    };
  }
  if (simulate && decision?.send && recipient) {
    return {
      type: FCM_TYPE_LOCKOUT_GUEST,
      title: `Lockout notice (sim) — ${name}`,
      body: `Would send to ${unit} via ${platform}. Guest send skipped (simulation).`,
      data,
    };
  }
  if (sent) {
    return {
      type: FCM_TYPE_LOCKOUT_GUEST,
      title: `Lockout notice sent — ${name}`,
      body: `${unit} via ${platform}. Wait 1–5 minutes, then retry last-4.`,
      data,
    };
  }
  if (decision?.reason === 'backdoor_both_occupied') {
    return {
      type: FCM_TYPE_LOCKOUT_GUEST,
      title: `Backdoor lockout — no guest message${sim}`,
      body: '1B and Apt #2 both occupied. Android alert only.',
      data,
    };
  }
  return {
    type: FCM_TYPE_LOCKOUT_GUEST,
    title: `Lockout guest notice skipped${sim}`,
    body: `${label}: ${decision?.reason || sendSkipReason || 'no_recipient'}`.slice(0, 900),
    data,
  };
}
