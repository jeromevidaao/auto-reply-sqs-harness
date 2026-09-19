/**
 * Programmatic claim checker — no LLM.
 *
 * Grounds the draft against tool results and known incident rules:
 * stay-extension calendar, host "unit ready" vs 4pm, pet max, post-checkout
 * parking, already-cancelled 475 links, event false positives,
 * WiFi credential re-send after guest already knows WiFi / prior host WiFi (generic; Sarah is one example).
 */

import { isAdditionalParkingAsk, isEventHostingDenial, isTripPurposeEventMention } from '../tools/parking/additionalParking.js';
import { isPetOverMaxAsk, isUnlikelyEventIdiom } from '../tools/pets/petOverMax.js';
import { isPetFurnitureMitigation } from '../tools/pets/petFurnitureMitigation.js';
import { hasPriorConversation } from '../utils/threadHistory.js';

const EVENT_DECLINE_RE = /not able to accommodate events or gatherings/i;
const POLICY_475_RE = /help\/article\/475/i;
const FOUR_PM_RE = /\b4\s*pm\b|\b4:00\s*pm\b|check-?in time is 4/i;
const WELCOME_LOGISTICS_RE = /self-check-in|detailed check-in instructions 3 days|one dedicated off-street parking/i;
const OWN_SPOT_AFTER_CHECKOUT_RE = /(?:keep|leave|use) (?:your|the) (?:car|spot|parking).{0,40}after (?:checkout|10)/i;


const WIFI_CRED_DUMP_RE =
  /(?:wifi|wi-?fi)\s+network\s+is\b|\bpassword\s+is\s+\S+|\bpineland\b|\blobsterbake\b/i;
const HOST_WIFI_HISTORY_RE =
  /(?:wifi|wi-?fi)\s+network\s+is\b|\bpassword\s+is\s+[\w.-]{4,}\b|\bpineland\b.*\blobsterbake\b|\blobsterbake\b.*\bpineland\b/i;
const WIFI_COMPLIMENT_RE =
  /\b(love|like|loved|liked|great|awesome|wonderful|amazing|perfect|excellent|fantastic|cool)\b[\s\S]{0,40}\b(wifi|wi-?fi|password|network)\b|\b(wifi|wi-?fi|password|network)\b[\s\S]{0,40}\b(love|like|loved|liked|great|awesome|wonderful|amazing|perfect|excellent|fantastic|cool)\b/i;
const WIFI_EXPLICIT_ASK_RE =
  /\b(what(?:'s| is) the (?:wifi|wi-?fi|password)|can you (?:send|share|give|remind).{0,20}password|need (?:the |your )?(?:wifi |wi-?fi )?password|forgot.{0,10}password|remind me.{0,15}password)\b/i;
const EARLY_CHECKIN_ASK_RE =
  /\b(early\s+check[- ]?in|check[- ]?in\s+earlier|arrive\s+early|come\s+(?:in|by)\s+early|before\s+4|earlier\s+than\s+4)\b/i;

function isWifiComplimentMessage(msg = '') {
  const m = String(msg || '');
  if (!/\b(wifi|wi-?fi|password|network)\b/i.test(m)) return false;
  if (!WIFI_COMPLIMENT_RE.test(m)) return false;
  if (WIFI_EXPLICIT_ASK_RE.test(m)) return false;
  return true;
}

function hostAlreadySentWifiInHistory(context = {}) {
  const history = Array.isArray(context.conversationHistory) ? context.conversationHistory : [];
  return history.some((row) => {
    const role = String(row?.sender_type || row?.role || row?.sender?.type || row?.sender || '').toLowerCase();
    if (!(role === 'host' || role === 'host_message' || role === 'owner')) return false;
    const body = String(row?.body || row?.message || row?.text || row?.content || '');
    return HOST_WIFI_HISTORY_RE.test(body);
  });
}

/** Guest-agnostic signals that the guest already knows WiFi (compliment is one of them). */
function guestSignalsKnowsWifi(text = '') {
  const m = String(text || '');
  if (!m.trim()) return false;
  if (isWifiComplimentMessage(m)) return true;
  if (
    /\b(?:got it|got the (?:wifi |wi-?fi )?password|thanks for (?:the )?(?:wifi |wi-?fi )?password|thank you for (?:the )?(?:wifi |wi-?fi )?password)\b/i.test(
      m
    )
  ) {
    return true;
  }
  if (
    /\b(?:wifi|wi-?fi)(?:\s+(?:password|network))?\b[\s\S]{0,40}\b(?:works|working|connected|great|awesome|perfect|good)\b/i.test(
      m
    ) ||
    /\b(?:works|working|connected|great|awesome|perfect)\b[\s\S]{0,40}\b(?:wifi|wi-?fi)(?:\s+(?:password|network))?\b/i.test(
      m
    )
  ) {
    return true;
  }
  if (
    /\b(?:logged in|we(?:'|’)re online|we are online|online now|got (?:on|onto) (?:the )?(?:wifi|wi-?fi|network))\b/i.test(
      m
    )
  ) {
    return true;
  }
  return false;
}

function isGuestHistoryRole(row = {}) {
  const role = String(row?.sender_type || row?.role || row?.sender?.type || row?.sender || '').toLowerCase();
  return role === 'guest' || role === 'guest_message';
}

/**
 * True when current message or prior GUEST turns show they know WiFi,
 * or host already sent credentials and guest is not explicitly re-asking.
 */
function guestAlreadyKnowsWifiFromHistory(guestMessage = '', context = {}) {
  const msg = String(guestMessage || '');
  const explicitAsk = WIFI_EXPLICIT_ASK_RE.test(msg) && !isWifiComplimentMessage(msg);
  if (explicitAsk) return false;
  if (guestSignalsKnowsWifi(msg)) return true;
  const history = Array.isArray(context.conversationHistory) ? context.conversationHistory : [];
  for (const row of history) {
    if (!isGuestHistoryRole(row)) continue;
    const body = String(row?.body || row?.message || row?.text || row?.content || '');
    if (guestSignalsKnowsWifi(body)) return true;
  }
  if (hostAlreadySentWifiInHistory(context)) return true;
  return false;
}

function draftHasWifiCredentialDump(draft = '') {
  return WIFI_CRED_DUMP_RE.test(String(draft || ''));
}

function stripWifiCredentialSentences(draft = '') {
  let d = String(draft || '');
  d = d.replace(/(?:the\s+)?(?:wifi|wi-?fi)\s+network\s+is\s+\S+[^.!?]*[.!?]?/gi, '');
  d = d.replace(/\b(?:and\s+)?the\s+password\s+is\s+\S+(?:\s*\([^)]*\))?[^.!?]*[.!?]?/gi, '');
  
  
  d = d.replace(/\bpineland\b/gi, '');
  d = d.replace(/\blobsterbake\b/gi, '');
  d = d.replace(/\blet me know if it works\.?/gi, '');
  return d.replace(/\s+/g, ' ').trim();
}

function earlyCheckinClassicFromContext(context = {}, guestMessage = '') {
  const rawName = context.guestDisplayName || context.guestName || 'there';
  const name = String(rawName).split(/[\s(]/)[0] || 'there';
  return (
    `Hi ${name}. Check-in is at 4pm and we can't guarantee early check-in, but as soon as cleaning finishes getting the unit ready for you we'll message you right away.`
  );
}

function lower(s) {
  return String(s || '');
}

function addIssue(issues, code, message, extra = {}) {
  issues.push({ code, message, ...extra });
}

function tracesOf(context = {}, toolResults = {}) {
  return toolResults.conversationContext || context.conversationTraces || {};
}

/**
 * @returns {{
 *   ok: boolean,
 *   issues: Array<{code: string, message: string, deterministicFix?: string}>,
 *   revisedResponse: string|null,
 * }}
 */
export function checkDraftClaims({
  draft = '',
  guestMessage = '',
  context = {},
  decision = {},
  toolResults = {},
} = {}) {
  const issues = [];
  const text = lower(draft);
  const msg = String(guestMessage || context.originalMessage || '');
  const traces = tracesOf(context, toolResults);
  const stay = toolResults.stayExtension || context.stayExtensionInfo || null;
  const parking = toolResults.postCheckoutParking || context.postCheckoutParkingInfo || null;
  const cancellation = toolResults.cancellation || context.cancellationInfo || null;

  if (traces.earlyUnitReadyOffered && FOUR_PM_RE.test(text)) {
    addIssue(
      issues,
      'ready_vs_4pm',
      'Draft restates 4pm after the host already said the unit is ready.',
      { deterministicFix: 'strip_4pm' }
    );
  }

  if (traces.recentWelcomeSent && WELCOME_LOGISTICS_RE.test(text) && /thank/i.test(msg)) {
    addIssue(
      issues,
      'welcome_repeat',
      'Draft re-sends welcome logistics on a post-welcome thank-you.'
    );
  }

  if (stay?.detected && stay.calendarChecked === false) {
    if (/\b(available|open|free to book|looks open)\b/i.test(text) && !/i'?ll check the calendar/i.test(text)) {
      addIssue(
        issues,
        'calendar_ungrounded',
        'Stay-extension draft claims availability without a successful calendar check.'
      );
    }
  }

  if (stay?.detected && stay.calendarChecked && stay.allAvailable === false) {
    if (/\b(those dates are available|nights are open|you(?:'re| are) all set to extend)\b/i.test(text)) {
      addIssue(
        issues,
        'calendar_false_open',
        'Draft claims extra nights are available but the calendar check said they are not.'
      );
    }
  }

  if (stay?.detected && stay.calendarChecked && stay.allAvailable === true) {
    if (/\b(already booked|not available|nights are blocked)\b/i.test(text)) {
      addIssue(
        issues,
        'calendar_false_blocked',
        'Draft claims extra nights are blocked but the calendar check said they are open.'
      );
    }
  }

  if (parking?.detected && parking.allowOwnSpot !== true) {
    if (OWN_SPOT_AFTER_CHECKOUT_RE.test(text) || /you can leave (?:your|the) car in your (?:spot|space)/i.test(text)) {
      addIssue(
        issues,
        'post_checkout_own_spot',
        'Draft allows the guest to keep their own parking spot after checkout.'
      );
    }
  }

  if (isPetOverMaxAsk(msg) && !/maximum 2 dogs|can'?t accommodate a third|cannot accommodate a third/i.test(text)) {
    addIssue(
      issues,
      'pet_over_max_missing',
      'Third-dog ask must state the maximum 2 dogs policy.'
    );
  }

  const eventFalsePositive =
    isPetOverMaxAsk(msg) ||
    isUnlikelyEventIdiom(msg) ||
    isAdditionalParkingAsk(msg) ||
    isEventHostingDenial(msg) ||
    isTripPurposeEventMention(msg);

  if (eventFalsePositive && EVENT_DECLINE_RE.test(text)) {
    addIssue(
      issues,
      'event_false_positive',
      'Draft uses the events decline on a non-event ask (pets / second car / trip-purpose).',
      { deterministicFix: 'strip_event_decline' }
    );
  }

  const alreadyCancelled =
    cancellation?.alreadyCancelled === true ||
    String(context.reservationStatus || context.reservation_status || '').toLowerCase() === 'cancelled';
  if ((alreadyCancelled || isPetFurnitureMitigation(msg)) && POLICY_475_RE.test(text)) {
    addIssue(
      issues,
      'policy_475_forbidden',
      'Draft links Airbnb 475 when the reservation is already cancelled or furniture mitigation applies.',
      { deterministicFix: 'strip_475' }
    );
  }


  // Generic: guest already knows WiFi (compliment / prior guest ack / host sent) —
  // never re-dump SSID/password unless they explicitly ask again. Prefer early-checkin
  // classic when that was the actionable ask. Sarah is one example only.
  const wifiCompliment = isWifiComplimentMessage(msg);
  const guestKnowsWifi = guestAlreadyKnowsWifiFromHistory(msg, context);
  const wifiDump = draftHasWifiCredentialDump(text);
  const explicitWifiAsk = WIFI_EXPLICIT_ASK_RE.test(msg) && !wifiCompliment;
  if (wifiDump && !explicitWifiAsk && guestKnowsWifi) {
    const earlyAsk = EARLY_CHECKIN_ASK_RE.test(msg);
    addIssue(
      issues,
      'wifi_resend_after_known',
      'Draft re-sends WiFi credentials after the guest already knows them (compliment, prior guest ack like "wifi works", or host already shared credentials in-thread).',
      {
        deterministicFix: earlyAsk ? 'force_early_checkin_classic' : 'strip_wifi_credentials',
      }
    );
  }


  // Sara miss: multi-ask late checkout + luggage — draft must refuse late checkout AND cover luggage.
  const LATE_CHECKOUT_ASK_RE =
    /\b(late\s*check[\s-]*out|later\s+check[\s-]*out|check[\s-]*out\s+later|later\s+checkout|checkout\s+later)\b/i;
  const LUGGAGE_ASK_RE = /\b(luggage|suitcase|bags?\b).{0,40}\b(drop|store|storage|leave|keep)|keep our luggage|luggage (?:at|drop)/i;
  const LATE_CHECKOUT_REFUSE_RE =
    /cannot allow late checkout|can't allow late checkout|unable to (?:allow|accommodate) (?:a )?late checkout|checkout is strictly (?:at )?10/i;
  const LATE_CHECKOUT_GRANT_RE =
    /\bwe can (?!not )(?:definitely |certainly )?(?:allow|offer|do|accommodate) .{0,20}late checkout|late checkout(?: is)? (?:ok|fine|available|approved)/i;
  const LUGGAGE_COVER_RE = /richard/i;
  const lateAsk = LATE_CHECKOUT_ASK_RE.test(msg) && !/(one more night|extra night|extend (?:our |the )?stay)/i.test(msg);
  const luggageAsk = LUGGAGE_ASK_RE.test(msg) || /\bluggage\b/i.test(msg);
  if (lateAsk && !LATE_CHECKOUT_REFUSE_RE.test(text)) {
    addIssue(
      issues,
      'late_checkout_refuse_missing',
      'Guest asked for late checkout but draft does not refuse it (Jerome: never grant; cleaning / next guests).',
      { deterministicFix: 'force_late_checkout_luggage_combo' }
    );
  }
  if (lateAsk && LATE_CHECKOUT_GRANT_RE.test(text)) {
    addIssue(
      issues,
      'late_checkout_granted',
      'Draft grants late checkout — forbidden (cleaning / next guests).',
      { deterministicFix: 'force_late_checkout_luggage_combo' }
    );
  }
  if (luggageAsk && (!LUGGAGE_COVER_RE.test(text) || !/\d{3}/.test(text.replace(/\D/g, '')))) {
    addIssue(
      issues,
      'luggage_richard_missing',
      'Guest luggage ask present but draft omits Richard + phone.',
      { deterministicFix: 'force_late_checkout_luggage_combo' }
    );
  }
  if (lateAsk && luggageAsk) {
    const missesLate = !LATE_CHECKOUT_REFUSE_RE.test(text) || LATE_CHECKOUT_GRANT_RE.test(text);
    const missesLuggage = !LUGGAGE_COVER_RE.test(text);
    if (missesLate || missesLuggage) {
      addIssue(
        issues,
        'multi_intent_late_checkout_luggage',
        'Multi-intent miss: guest asked late checkout AND luggage; draft must refuse late checkout and cover Richard luggage (Sara production miss).',
        { deterministicFix: 'force_late_checkout_luggage_combo' }
      );
    }
  }


  let revised = text;
  let appliedFix = false;
  const appliedFixCodes = new Set();
  for (const issue of issues) {
    if (issue.deterministicFix && appliedFixCodes.has(issue.deterministicFix)) continue;
    if (issue.deterministicFix === 'strip_4pm') {
      revised = revised.replace(/[^.]*\b4\s*pm\b[^.]*\.?/gi, '').replace(/\s{2,}/g, ' ').trim();
      appliedFix = true;
    } else if (issue.deterministicFix === 'strip_event_decline') {
      revised = revised.replace(/[^.]*not able to accommodate events or gatherings[^.]*\.?/gi, '').trim();
      appliedFix = true;
    } else if (issue.deterministicFix === 'strip_475') {
      revised = revised.replace(/https?:\/\/www\.airbnb\.com\/help\/article\/475/gi, '').replace(/help\/article\/475/gi, '').trim();
      appliedFix = true;
    } else if (issue.deterministicFix === 'strip_wifi_credentials') {
      revised = stripWifiCredentialSentences(revised);
      appliedFix = true;
    } else if (issue.deterministicFix === 'force_late_checkout_luggage_combo') {
      const rawName = context.guestDisplayName || context.guestName || 'there';
      const name = String(rawName).split(/[\s(]/)[0] || 'there';
      const refuse =
        'Sorry we cannot allow late checkout because we have guests right after you and the cleaning team needs this time to get the unit ready for them. Checkout is strictly at 10AM';
      const wantsLuggage = /\bluggage\b|suitcase|bags?/i.test(msg);
      let luggageBit = '';
      if (wantsLuggage) {
        const existing = revised.match(/[^.!?]*richard[^.!?]*[.!?]/i);
        luggageBit = existing
          ? existing[0].trim()
          : 'Yes, you can coordinate an early luggage drop-off with Richard, our on-site property manager, at (207) 807-8071.';
      }
      revised = (`Good evening, ${name}. ${refuse.replace(/\.?$/, '')}.` + (luggageBit ? ` ${luggageBit}` : '')).replace(/\s+/g, ' ').trim();
      appliedFix = true;
      appliedFixCodes.add(issue.deterministicFix);
    } else if (issue.deterministicFix === 'force_early_checkin_classic') {
      revised = earlyCheckinClassicFromContext(context, msg);
      appliedFix = true;
    }
  }

  const remaining = issues.filter((i) => !i.deterministicFix);
  const ok = remaining.length === 0 && (!appliedFix || remaining.length === 0);
  // After deterministic strips, re-evaluate only unfixed issues.
  const okAfterFixes = remaining.length === 0;

  return {
    ok: issues.length === 0,
    issues,
    revisedResponse: appliedFix && revised && revised !== text ? revised : null,
    okAfterFixes,
    category: decision.typeOfMessageReceived || null,
  };
}

const CANCELLATION_CATEGORIES = new Set([
  'CANCELLATION',
  'CANCELLATION_POLICY',
  'CANCELLATION_NOTIFICATION',
  'CANCELLATION_POLICY_EXCEPTION',
]);

function categoryList(decision = {}) {
  const raw = decision.typeOfMessageReceived;
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Skip the LLM reviewer when a deterministic policy already rewrote the draft
 * and programmatic claims are clean. Never skip cancellations, failed history,
 * or any thread that already has conversation history — the judge must see the
 * full thread to catch repetition (Ted Apt 3 HVAC follow-up).
 */
export function shouldSkipLlmJudge({
  decision = {},
  claimCheck = {},
  context = {},
} = {}) {
  const cats = categoryList(decision);
  if (cats.some((c) => CANCELLATION_CATEGORIES.has(c))) return false;
  if (context.forceCancellationEscalation) return false;
  const traces = context.conversationTraces || {};
  if (traces.historyFetchFailed) return false;
  if (hasPriorConversation(context)) return false;
  if (cats.some((c) => c === 'THERMOSTAT_HEATPUMP' || c === 'THERMOSTAT')) return false;
  if (!decision.deterministicRewrite && !claimCheck.revisedResponse) return false;
  if (claimCheck.ok === true) return true;
  if (claimCheck.okAfterFixes === true && claimCheck.revisedResponse) return true;
  return false;
}
