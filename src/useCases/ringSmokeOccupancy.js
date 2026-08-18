/**
 * Occupancy + routing for Apt #2 Ring smoke / CO guest notices.
 * Reuses Hospitable + HE current-guest loaders from keypad lockout.
 */
import {
  guestFirstName,
  LISTING_APT2,
  loadCurrentGuestsByListing,
  nyTodayAndHour,
  pickCurrentGuest,
} from './keypadLockoutOccupancy.js';

export {
  guestFirstName,
  LISTING_APT2,
  loadCurrentGuestsByListing,
  nyTodayAndHour,
};

export const RING_SMOKE_NOTICE_ACT = 'ring_smoke_notice';
export const FCM_TYPE_SMOKE_GUEST = 'ring_smoke_guest_notice';
export const LISTING_SMOKE = LISTING_APT2;
export const PROPERTY_NAME = 'Pine Apt #2';

export const SMOKE_GUEST_TEMPLATE = [
  'Hi {FirstName},',
  '',
  'A quick heads-up: the {detectorName} {alarmKind} detector just went off in Pine Apt #2. Please check the apartment now.',
  '',
  'If there is a real fire or you smell gas / feel unwell: leave immediately, close the door behind you, and call 911. Do not go back inside until it is safe.',
  '',
  'If this is cooking smoke or steam: open windows, turn on the fan, and the alarm should stop once the air clears. Reply here if you need help.',
  '',
  'Warm regards,',
  'Jerome',
  '',
].join('\n');

export function decideSmokeRecipients(guestsByListing, today, hourNy) {
  const guests = (guestsByListing && guestsByListing[LISTING_APT2]) || [];
  const current = [];
  const seen = new Set();
  for (const g of Array.isArray(guests) ? guests : []) {
    const picked = pickCurrentGuest([g], today, hourNy);
    if (!picked) continue;
    const id =
      picked.platform +
      ':' +
      (picked.reservationId || picked.conversationId || picked.guestName || '');
    if (seen.has(id)) continue;
    seen.add(id);
    current.push({ ...picked, listingId: picked.listingId || LISTING_APT2 });
  }
  // pickCurrentGuest on a 1-item array still applies checkout-morning 10am ET.
  // If two platforms are both current (same-day AB / HE overlap), keep both.
  if (!current.length) {
    return { send: false, reason: 'unit_vacant', recipients: [] };
  }
  return { send: true, reason: 'unit_occupied', recipients: current };
}

export function fillSmokeGuestTemplate(firstName, detectorName, alarmKind) {
  const name = String(firstName || 'there').trim() || 'there';
  const detector = String(detectorName || 'smoke detector').trim() || 'smoke detector';
  const kind = String(alarmKind || 'smoke').trim() || 'smoke';
  return SMOKE_GUEST_TEMPLATE.replace(/\{FirstName\}/g, name)
    .replace(/\{detectorName\}/g, detector)
    .replace(/\{alarmKind\}/g, kind);
}

export function alreadySentSmokeNotice(messages, detectorName) {
  const detector = String(detectorName || '').toLowerCase();
  const list = Array.isArray(messages) ? messages : [];
  return list.some((m) => {
    const text = String(m?.content || m?.body || m?.text || '').toLowerCase();
    if (!text) return false;
    if (!/smoke detector just went off|co detector just went off|carbon monoxide detector just went off/.test(text)) {
      return false;
    }
    if (detector && !text.includes(detector.toLowerCase())) return false;
    return true;
  });
}

export function isRingSmokeNoticeAct(value) {
  const raw = String(value || '').toLowerCase();
  return (
    raw === RING_SMOKE_NOTICE_ACT ||
    raw === 'ring.smoke.detected' ||
    raw === 'ring_smoke_detected'
  );
}

export function isRingSmokeNoticeTurn(event = null) {
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
    if (isRingSmokeNoticeAct(act)) return true;
    if (isRingSmokeNoticeAct(p?.action) || isRingSmokeNoticeAct(p?.data?.action)) {
      return true;
    }
  }
  return false;
}

export function extractSmokeNoticeContext(event = null) {
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
    if (p?.detectorName || p?.smokeKey) {
      data = { ...data, ...p };
    }
  }
  const simulate = data.simulate === true || data.simulate === 'true' || data.simulate === 1;
  const sendGuestsRaw = data.sendGuests;
  const sendGuests =
    !simulate && sendGuestsRaw !== false && sendGuestsRaw !== 'false' && sendGuestsRaw !== 0;
  return {
    detectorName: data.detectorName || data.name || 'smoke detector',
    detectorKey: data.detectorKey || '',
    detectorId: data.detectorId || data.doorbotId || '',
    alarmKind: data.alarmKind || 'smoke',
    listingId: data.listingId || LISTING_APT2,
    propertyName: data.propertyName || PROPERTY_NAME,
    eventAt: data.eventAt || '',
    smokeKey: data.smokeKey || data.id || '',
    instruction: data.instruction || '',
    simulate,
    sendGuests,
  };
}

export function buildSmokeGuestNotify({
  simulate,
  decision,
  recipients,
  detectorName,
  alarmKind,
  proposedResponse,
  sent,
  sentCount,
  sendError,
  sendSkipReason,
} = {}) {
  const name = detectorName || 'smoke detector';
  const kind = alarmKind || 'smoke';
  const list = Array.isArray(recipients) ? recipients : [];
  const first = list[0] || null;
  const guest = first ? guestFirstName(first) : 'guest';
  const platforms = [
    ...new Set(
      list.map((r) => (r.platform === 'homeexchange' ? 'Home Exchange' : 'Airbnb'))
    ),
  ];
  const platformLabel = platforms.join(' + ') || 'Airbnb / HE';
  const sim = simulate ? ' (sim)' : '';
  const data = {
    type: FCM_TYPE_SMOKE_GUEST,
    listingId: LISTING_APT2,
    listingName: PROPERTY_NAME,
    detectorName: String(name),
    alarmKind: String(kind),
    guestName: String(guest),
    platform: String(first?.platform || ''),
    reason: String(decision?.reason || sendSkipReason || ''),
    simulate: simulate ? 'true' : 'false',
    sent: sent ? 'true' : 'false',
    sentCount: String(sentCount || (sent ? 1 : 0)),
    color: '#DC2626',
  };

  if (sendError) {
    return {
      type: FCM_TYPE_SMOKE_GUEST,
      title: `Smoke guest notice failed${sim}`,
      body: `${name}: ${sendError}`.slice(0, 900),
      data: { ...data, error: String(sendError) },
    };
  }
  if (simulate && decision?.send && first) {
    return {
      type: FCM_TYPE_SMOKE_GUEST,
      title: `Smoke detected (sim) — ${guest}`,
      body: `Would message Apt #2 guests via ${platformLabel} about the ${name} ${kind} detector. Guest send skipped (simulation).`,
      data,
    };
  }
  if (sent) {
    return {
      type: FCM_TYPE_SMOKE_GUEST,
      title: `Smoke detected — message sent to ${guest}`,
      body: `Apt #2 ${name} ${kind} detector. Message sent via ${platformLabel}.`,
      data,
    };
  }
  if (decision?.reason === 'unit_vacant') {
    return {
      type: FCM_TYPE_SMOKE_GUEST,
      title: `Smoke detected — Apt #2 vacant${sim}`,
      body: `${name} ${kind} detector. No current guests to message.`,
      data,
    };
  }
  return {
    type: FCM_TYPE_SMOKE_GUEST,
    title: `Smoke guest notice skipped${sim}`,
    body: `${name}: ${decision?.reason || sendSkipReason || 'no_recipient'}`.slice(0, 900),
    data,
  };
}
