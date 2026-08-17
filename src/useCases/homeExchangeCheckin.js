/**
 * Isolated HE 3-day (or last-minute) check-in instruction send.
 *
 * Never falls through to pre-approve / shared thank-you / Apt #3 default.
 * Unit is resolved only from a known HE home id; template.homeId must match.
 * Door PIN is the guest phone last-4 — abort if we cannot extract it.
 */
import { alreadySentEquivalent } from '../clients/HomeExchangeClient.js';
import { pickExchangeFromConversation } from '../clients/homeExchangeExchange.js';
import { notifyHeAutoReply } from './homeExchangeNotify.js';
import { loadCheckinTemplate } from './checkinTemplates/index.js';
import {
  HE_UNIT_BY_HOME,
  extractHeHomeId,
  extractHomeExchangeMessage,
  mergeHeConversationHistory,
} from './homeExchange.js';

export const HOMEEXCHANGE_CHECKIN_ACT = 'homeexchange_checkin_instructions';
export const HOMEEXCHANGE_CHECKIN_ACTION = 'homeexchange.checkin_instructions';
export const HOMEEXCHANGE_CHECKIN_EVENT = 'checkin_instructions';
export const HOMEEXCHANGE_CHECKIN_REASON = 'homeexchange_checkin_instructions';

export function resolveHeUnitStrict(homeId) {
  const key = homeId != null ? String(homeId).trim() : '';
  return HE_UNIT_BY_HOME[key] || null;
}

export function isHeCheckinInstructionsAct(value) {
  const raw = String(value || '').toLowerCase();
  return (
    raw === HOMEEXCHANGE_CHECKIN_ACT ||
    raw === HOMEEXCHANGE_CHECKIN_ACTION ||
    raw === HOMEEXCHANGE_CHECKIN_EVENT ||
    raw === 'homeexchange.checkin.instructions'
  );
}

export function isHeCheckinInstructionsTurn(context = {}, message = '', event = null) {
  if (isHeCheckinInstructionsAct(context.eventType)) return true;
  if (isHeCheckinInstructionsAct(context.action)) return true;
  if (isHeCheckinInstructionsAct(context.act)) return true;
  const act =
    event?.queryStringParameters?.act ||
    event?.act ||
    context.queryStringParameters?.act;
  if (isHeCheckinInstructionsAct(act)) return true;
  const raw = String(message || '');
  if (/^send check-in instructions$/i.test(raw.trim())) return true;
  return false;
}

/** Same NANP ranking as add-delete-code-wifi-pyschlage last4_from_phones. */
export function extractPhoneLast4(phones) {
  const list = Array.isArray(phones) ? phones : phones != null ? [phones] : [];
  const scored = [];
  for (const p of list) {
    const digits = String(p || '').replace(/\D/g, '');
    if (digits.length < 4) continue;
    let rank = 1;
    if (digits.length === 11 && digits.startsWith('1')) rank = 3;
    else if (digits.length === 10) rank = 2;
    scored.push({ rank, digits });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => (b.rank !== a.rank ? b.rank - a.rank : a.digits < b.digits ? 1 : -1));
  return scored[0].digits.slice(-4);
}

export function collectGuestPhones(guest = {}) {
  const phones = [];
  for (const key of ['phone', 'phone_number', 'mobile']) {
    if (guest && guest[key]) phones.push(guest[key]);
  }
  for (const key of ['phones', 'phone_numbers']) {
    const raw = guest && guest[key];
    if (Array.isArray(raw)) phones.push(...raw);
    else if (raw) phones.push(raw);
  }
  return phones;
}

export function fillCheckinTemplate(templateText, { firstName, last4 } = {}) {
  return String(templateText || '')
    .replace(/\{FirstName\}/g, firstName || 'there')
    .replace(/\{last4\}/g, last4 || '');
}

export function buildCheckinPersonalLine(history = [], guestName = '') {
  const texts = (Array.isArray(history) ? history : [])
    .filter((m) => {
      const role = String(m?.sender_type || m?.sender?.type || m?.role || '').toLowerCase();
      return role === 'guest' || role === 'exchanger';
    })
    .map((m) => String(m.content || m.body || m.text || ''));
  const blob = texts.join(' \n ');
  if (!blob.trim()) return null;
  const name = guestName || 'there';
  if (/late|after\s*(\d|midnight)|arriv(?:e|ing)\s+(?:late|after|around)/i.test(blob)) {
    return `Looking forward to seeing you, ${name} — self-check-in works if you arrive after 4pm.`;
  }
  if (/grand(?:child|kid)|kids?|children|family/i.test(blob)) {
    return `Looking forward to hosting you and the family, ${name}.`;
  }
  if (/first (?:time|visit)|never been|haven't been/i.test(blob)) {
    return `Excited for your first visit to Portland, ${name}.`;
  }
  return null;
}

export function applyCheckinPersonalLine(filled, personalLine) {
  if (!personalLine) return filled;
  const hi = filled.match(/^Hi [^,\n]+,\n\n/);
  if (!hi) return `${personalLine}\n\n${filled}`;
  return `${hi[0]}${personalLine}\n\n${filled.slice(hi[0].length)}`;
}

export function verifyCheckinDraft(body, template, last4) {
  const text = String(body || '');
  const reasons = [];
  if (!last4 || !/^\d{4}$/.test(String(last4))) {
    reasons.push('missing_last4');
  } else if (!text.includes(String(last4))) {
    reasons.push('draft_missing_last4');
  }
  for (const needle of template?.mustInclude || []) {
    if (!text.toLowerCase().includes(String(needle).toLowerCase())) {
      reasons.push(`missing:${needle}`);
    }
  }
  for (const needle of template?.mustNotInclude || []) {
    if (text.toLowerCase().includes(String(needle).toLowerCase())) {
      reasons.push(`wrong_unit:${needle}`);
    }
  }
  if (template?.homeId && !text) reasons.push('empty_draft');
  return { ok: reasons.length === 0, reasons };
}

function guestFromExchange(exchange) {
  return exchange?.guest || exchange?.exchanger || {};
}

export function last4FromContextAndExchange(context = {}, exchange = null) {
  const fromPayload = [
    context.guestPhoneLast4,
    context.phoneLast4,
    context.last4,
  ];
  for (const v of fromPayload) {
    const digits = String(v || '').replace(/\D/g, '');
    if (digits.length === 4) return digits;
  }
  const phones = [
    context.guestPhone,
    context.phoneNumber,
    context.phone,
    context.guest?.phone,
    ...collectGuestPhones(context.guest || {}),
    ...collectGuestPhones(guestFromExchange(exchange)),
  ];
  return extractPhoneLast4(phones);
}

export function homeIdFromExchange(exchange) {
  if (!exchange) return null;
  if (exchange.home?.id != null) return String(exchange.home.id);
  if (exchange.home_id != null) return String(exchange.home_id);
  if (exchange.home != null && typeof exchange.home !== 'object') return String(exchange.home);
  return null;
}

/**
 * Refuse to send unless payload home, live exchange home, and template home
 * are the same known Pine listing.
 */
export function resolveCheckinHomeId({ context = {}, liveExchange = null } = {}) {
  const payloadHome = extractHeHomeId(context);
  const liveHome = homeIdFromExchange(liveExchange);
  if (payloadHome && liveHome && String(payloadHome) !== String(liveHome)) {
    return { homeId: null, error: 'payload_live_home_mismatch', payloadHome, liveHome };
  }
  const homeId = liveHome || payloadHome;
  if (!homeId) return { homeId: null, error: 'missing_home_id', payloadHome, liveHome };
  if (!resolveHeUnitStrict(homeId)) {
    return { homeId: null, error: 'unknown_home_id', payloadHome, liveHome };
  }
  return { homeId: String(homeId), error: null, payloadHome, liveHome };
}

export async function handleHeCheckinInstructions({
  event,
  extracted = null,
  homeExchangeClient = null,
  notifyOwner = null,
  s3Client = null,
} = {}) {
  const parsed = extracted || extractHomeExchangeMessage(event);
  const context = parsed.context || {};
  const conversationId = context.conversation_id || context.conversationId || null;
  const providedHistory = Array.isArray(context.conversationHistory)
    ? context.conversationHistory
    : [];

  let liveConversation = null;
  let liveExchange = null;
  let liveMessages = [];
  if (conversationId && homeExchangeClient?.getConversation) {
    try {
      liveConversation = await homeExchangeClient.getConversation(conversationId);
      liveExchange = pickExchangeFromConversation(
        liveConversation,
        extractHeHomeId(context)
      );
    } catch {
      liveConversation = null;
      liveExchange = null;
    }
  }
  if (conversationId && homeExchangeClient?.listMessages) {
    try {
      liveMessages = await homeExchangeClient.listMessages(conversationId);
    } catch {
      liveMessages = [];
    }
  }
  const conversationHistory = mergeHeConversationHistory(providedHistory, liveMessages);

  const resolved = resolveCheckinHomeId({ context, liveExchange });
  const unit = resolved.homeId ? resolveHeUnitStrict(resolved.homeId) : null;
  const guestName =
    context.guestName ||
    context.sender?.first_name ||
    guestFromExchange(liveExchange)?.first_name ||
    liveConversation?.interlocutor?.first_name ||
    null;
  const last4 = last4FromContextAndExchange(context, liveExchange);

  const notifyBase = {
    guestName: guestName || 'Guest',
    checkIn: context.checkIn || liveExchange?.start_on || null,
    checkOut: context.checkOut || liveExchange?.end_on || null,
    conversationId,
    exchangeId: liveExchange?.id || null,
    propertyName: unit?.propertyName || '',
    listingId: unit?.airbnbListingId || '',
    homeId: resolved.homeId || extractHeHomeId(context) || '',
    reason: HOMEEXCHANGE_CHECKIN_REASON,
  };

  const abort = async (error, extra = {}) => {
    try {
      await notifyHeAutoReply(notifyOwner, {
        kind: 'send_failed',
        ...notifyBase,
        error,
        proposedResponse: '',
      });
    } catch (notifyErr) {
      console.error('[HomeExchange] check-in FCM fail notify failed', notifyErr?.message || notifyErr);
    }
    return {
      platform: 'homeexchange',
      typeOfMessageReceived: 'HOMEEXCHANGE_CHECKIN_INSTRUCTIONS',
      shouldReply: false,
      sendDisabled: true,
      sent: false,
      sendError: error,
      sendSkipReason: extra.sendSkipReason || error,
      reason: HOMEEXCHANGE_CHECKIN_REASON,
      proposedResponse: extra.proposedResponse || '',
      conversationId,
      guestName,
      last4: last4 || null,
      homeId: resolved.homeId,
      unit: unit || null,
      templateSource: extra.templateSource || null,
      verify: extra.verify || null,
      preapprove: { attempted: false, ok: false },
      guestFinalized: false,
      checkinInstructions: true,
      ...extra,
    };
  };

  if (resolved.error || !unit) {
    return abort(resolved.error || 'unknown_home_id');
  }
  if (!last4) {
    return abort('missing_guest_phone_last4');
  }

  const loaded = await loadCheckinTemplate({ homeId: resolved.homeId, s3Client });
  if (!loaded.template) {
    return abort(loaded.error || 'missing_checkin_template', { templateSource: loaded.source });
  }
  if (String(loaded.template.homeId) !== String(resolved.homeId)) {
    return abort('template_home_mismatch', { templateSource: loaded.source });
  }

  const filled = fillCheckinTemplate(loaded.template.template, {
    firstName: guestName || 'there',
    last4,
  });
  const personal = buildCheckinPersonalLine(conversationHistory, guestName);
  const proposedResponse = applyCheckinPersonalLine(filled, personal);
  const verify = verifyCheckinDraft(proposedResponse, loaded.template, last4);
  if (!verify.ok) {
    return abort(`checkin_verify_failed:${verify.reasons.join(',')}`, {
      proposedResponse,
      verify,
      templateSource: loaded.source,
    });
  }

  let sent = false;
  let sendError = null;
  let sendSkipReason = null;
  if (!conversationId) {
    sendError = 'missing_conversation_id';
  } else if (!homeExchangeClient || typeof homeExchangeClient.sendMessage !== 'function') {
    sendSkipReason = 'no_homeexchange_client';
  } else {
    try {
      if (alreadySentEquivalent(liveMessages, proposedResponse)) {
        sendSkipReason = 'already_sent';
      } else {
        await homeExchangeClient.sendMessage(conversationId, proposedResponse);
        sent = true;
      }
    } catch (err) {
      sendError = err?.message || String(err);
    }
  }

  try {
    if (sent) {
      await notifyHeAutoReply(notifyOwner, {
        kind: 'sent',
        ...notifyBase,
        proposedResponse,
      });
    } else if (sendError) {
      await notifyHeAutoReply(notifyOwner, {
        kind: 'send_failed',
        ...notifyBase,
        proposedResponse,
        error: sendError,
      });
    }
  } catch (notifyErr) {
    console.error('[HomeExchange] check-in FCM notify failed', notifyErr?.message || notifyErr);
  }

  return {
    platform: 'homeexchange',
    typeOfMessageReceived: 'HOMEEXCHANGE_CHECKIN_INSTRUCTIONS',
    shouldReply: sent || (!sendError && !sendSkipReason),
    sendDisabled: !sent,
    sent,
    sendError,
    sendSkipReason,
    reason: HOMEEXCHANGE_CHECKIN_REASON,
    proposedResponse,
    conversationId,
    guestName,
    last4,
    homeId: resolved.homeId,
    unit,
    templateSource: loaded.source,
    verify,
    personalLine: personal,
    preapprove: { attempted: false, ok: false },
    guestFinalized: false,
    checkinInstructions: true,
    propertyName: unit.propertyName,
    airbnbListingId: unit.airbnbListingId,
    propertyId: unit.propertyId,
  };
}
