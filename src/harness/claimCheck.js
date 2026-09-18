/**
 * Programmatic claim checker — no LLM.
 *
 * Grounds the draft against tool results and known incident rules:
 * stay-extension calendar, host "unit ready" vs 4pm, pet max, post-checkout
 * parking, already-cancelled 475 links, event false positives,
 * WiFi credential re-send after compliment / prior host WiFi (Sarah 2026-09-17).
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
  /\b(?:ansia[_\s]?2\.4|10286500|pineland|lobsterbake)\b|(?:wifi|wi-?fi)\s+network\s+is\b|\bpassword\s+is\s+\S+/i;
const HOST_WIFI_HISTORY_RE =
  /(?:wifi|wi-?fi)\s+network\s+is\b|\bpassword\s+is\s+(?:pineland|lobsterbake|ansia|[\w.-]{4,})\b|\bpineland\b.*\blobsterbake\b|\blobsterbake\b.*\bpineland\b|\bansia[_\s]?2\.4\b|\b10286500\b/i;
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

function draftHasWifiCredentialDump(draft = '') {
  return WIFI_CRED_DUMP_RE.test(String(draft || ''));
}

function stripWifiCredentialSentences(draft = '') {
  let d = String(draft || '');
  d = d.replace(/(?:the\s+)?(?:wifi|wi-?fi)\s+network\s+is\s+\S+[^.!?]*[.!?]?/gi, '');
  d = d.replace(/\b(?:and\s+)?the\s+password\s+is\s+\S+(?:\s*\([^)]*\))?[^.!?]*[.!?]?/gi, '');
  d = d.replace(/\bansia[_\s]?2\.4\b/gi, '');
  d = d.replace(/\b10286500\b/g, '');
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


  // Sarah 2026-09-17: WiFi compliment / prior host already sent credentials —
  // never re-dump SSID/password (esp. wrong Ansia globals). Force early-checkin
  // classic when that was the actionable ask.
  const wifiCompliment = isWifiComplimentMessage(msg);
  const hostSentWifi = hostAlreadySentWifiInHistory(context);
  const wifiDump = draftHasWifiCredentialDump(text);
  const explicitWifiAsk = WIFI_EXPLICIT_ASK_RE.test(msg) && !wifiCompliment;
  if (wifiDump && !explicitWifiAsk && (wifiCompliment || hostSentWifi)) {
    const earlyAsk = EARLY_CHECKIN_ASK_RE.test(msg);
    addIssue(
      issues,
      'wifi_resend_after_known',
      'Draft re-sends WiFi credentials after the host already shared them and/or the guest only complimented the password (Sarah West End Victorian).',
      {
        deterministicFix: earlyAsk ? 'force_early_checkin_classic' : 'strip_wifi_credentials',
      }
    );
  }

  let revised = text;
  let appliedFix = false;
  for (const issue of issues) {
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
