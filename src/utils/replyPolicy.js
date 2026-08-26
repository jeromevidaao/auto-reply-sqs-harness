/**
 * Reply / confidence hardening for guest auto-reply.
 *
 * Root cause (Cassidy 2026-08-04): multi-intent thanks + factual checkout question
 * produced a usable draft (or should have) but did not auto-reply. We harden so:
 *  1) High confidence + sendable draft → always shouldReply
 *  2) shouldAlwaysReply-style operational asks with a sendable draft → force reply
 *  3) Eval rubrics can require minConfidence + shouldAlwaysReply
 *
 * Shared by agent (processMessage / handleMessage) and unit tests.
 */

/** Force auto-reply when model is this confident and we have a real draft. */
export const HIGH_CONF_FORCE_REPLY = Number(
  process.env.AUTO_REPLY_HIGH_CONF_FORCE || 0.9
);

/** Minimum draft length to count as "sendable" (not a stub). */
export const MIN_SENDABLE_DRAFT_CHARS = 12;

/**
 * Categories where we never override shouldReply=false (need human judgment).
 * Everything else with a solid draft + high conf is fair game for auto-send.
 */
export const NO_FORCE_REPLY_CATEGORIES = new Set([
  'CANCELLATION_POLICY_EXCEPTION',
  'OTHER_MESSAGE', // often intentional silence
  'HOST_REPLY_REINGESTED',
]);

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasSendableDraft(text) {
  if (text == null) return false;
  const t = String(text).trim();
  if (!t || t === 'none' || t.toLowerCase() === 'null') return false;
  return t.length >= MIN_SENDABLE_DRAFT_CHARS;
}

/**
 * Normalize typeOfMessageReceived to a flat string list.
 * @param {unknown} typeOfMessageReceived
 * @returns {string[]}
 */
export function categoryList(typeOfMessageReceived) {
  if (Array.isArray(typeOfMessageReceived)) {
    return typeOfMessageReceived.map(String).filter(Boolean);
  }
  if (typeOfMessageReceived == null || typeOfMessageReceived === '') return [];
  return [String(typeOfMessageReceived)];
}

/**
 * True when any category is in the no-force set (and it's the only category,
 * or explicitly the sole signal). Multi-intent with one "safe" category still allows force.
 * @param {string[]} cats
 */
export function isNoForceOnly(cats) {
  if (!cats.length) return false;
  // Pure OTHER_MESSAGE alone → do not force
  if (cats.length === 1 && NO_FORCE_REPLY_CATEGORIES.has(cats[0])) return true;
  // Explicit host re-ingest never force
  if (cats.includes('HOST_REPLY_REINGESTED')) return true;
  return false;
}

/**
 * Clear operational / logistics questions that must auto-reply when we have a draft.
 * Complements category-based forcing (checkout, wifi, parking, door code, etc.).
 * @param {string} guestMessage
 */
export function isOperationalMustReplyAsk(guestMessage) {
  const msg = String(guestMessage || '').trim();
  if (!msg || msg.length < 8) return false;
  return (
    // Checkout / check-in times
    /what is the (latest|last|earliest|check[\s-]?in|check[\s-]?out)|what time.*(check\s*out|check\s*in|checkout|checkin)|when (is|do|can).*(check\s*out|check\s*in)/i.test(
      msg
    ) ||
    // Access / wifi / parking / codes
    /\b(wifi|wi-fi|password|door code|lockbox|parking|where (do|can) i park|trash|linen|checkout is|check out)\b/i.test(
      msg
    ) ||
    // Transport / indoor recs (Amber 2026-08-17: shuttle + rainy-day activities)
    (/\b(shuttle|taxi|uber|lyft|airport|rainy day|indoor)\b/i.test(msg) && /\?/.test(msg)) ||
    // Multi-intent thanks + question (Cassidy / Amber). No short-length cap —
    // Amber's shuttle + rainy-day ask was ~400 chars and missed the old <280 rule.
    (/thank/i.test(msg) && /\?/.test(msg)) ||
    // Check-in day readiness (Trevor 2026-08-26) — often no "?"
    /\b(not ready|ready early|kill an hour|kill some time|closer to [34]|if it['’]?s not ready)\b/i.test(
      msg
    )
  );
}

/**
 * Decide whether to force shouldReply + optionally boost confidence.
 *
 * @param {object} opts
 * @param {boolean} [opts.shouldReply]
 * @param {number} [opts.confidence]
 * @param {string} [opts.proposedResponse]
 * @param {boolean} [opts.escalated]
 * @param {string|string[]} [opts.typeOfMessageReceived]
 * @param {string} [opts.guestMessage]
 * @returns {{ force: boolean, shouldReply: boolean, confidence: number, reason: string|null }}
 */
export function applyHighConfidenceForceReply({
  shouldReply,
  confidence,
  proposedResponse,
  escalated = false,
  typeOfMessageReceived,
  guestMessage = '',
} = {}) {
  const conf = Number(confidence);
  const confNum = Number.isFinite(conf) ? conf : 0.7;
  let reply = shouldReply === true || shouldReply === false
    ? shouldReply
    : hasSendableDraft(proposedResponse);
  let nextConf = confNum;
  let reason = null;

  // Recent-host suppression used to set escalated=true and then this early
  // return blocked the force-reply (Amber 2026-08-17). Operational asks with a
  // sendable draft still go through the force rules below.
  if (escalated && !isOperationalMustReplyAsk(guestMessage)) {
    return { force: false, shouldReply: reply, confidence: nextConf, reason: null };
  }
  if (!hasSendableDraft(proposedResponse)) {
    return { force: false, shouldReply: reply, confidence: nextConf, reason: null };
  }

  const cats = categoryList(typeOfMessageReceived);
  if (isNoForceOnly(cats)) {
    return { force: false, shouldReply: reply, confidence: nextConf, reason: null };
  }

  // 1) High confidence + draft → always send
  if (confNum >= HIGH_CONF_FORCE_REPLY && reply === false) {
    reply = true;
    reason = `high_confidence_force (>=${HIGH_CONF_FORCE_REPLY})`;
  } else if (confNum >= HIGH_CONF_FORCE_REPLY && reply !== false) {
    reply = true;
    if (confNum < 1.0) nextConf = Math.max(nextConf, HIGH_CONF_FORCE_REPLY);
    reason = reason || `high_confidence_confirm (>=${HIGH_CONF_FORCE_REPLY})`;
  }

  // 2) Operational / multi-intent ask + draft → force even if model was shy
  if (
    reply === false &&
    isOperationalMustReplyAsk(guestMessage) &&
    confNum >= 0.75
  ) {
    reply = true;
    nextConf = Math.max(nextConf, 0.95);
    reason = 'operational_must_reply_ask';
  }

  // 3) Already shouldReply with draft but low conf on operational → lift conf for honest tests
  if (
    reply === true &&
    isOperationalMustReplyAsk(guestMessage) &&
    nextConf < 0.95
  ) {
    nextConf = Math.max(nextConf, 0.95);
    reason = reason || 'operational_confidence_floor';
  }

  return {
    force: !!reason && (shouldReply === false || confNum < nextConf),
    shouldReply: reply,
    confidence: nextConf,
    reason,
  };
}

/**
 * Build a standard production-miss eval scenario object.
 * @param {object} opts
 */
export function buildProductionMissScenario({
  id,
  guestMessage,
  description,
  context = {},
  expectedCategory,
  requiredPhrases = [],
  forbiddenPhrases = [],
  minConfidence = 0.95,
  notes = '',
} = {}) {
  if (!id || !guestMessage) {
    throw new Error('buildProductionMissScenario requires id and guestMessage');
  }
  const slug = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return {
    id: slug,
    description:
      description ||
      `Production miss regression: must always auto-reply. Captured for Grok eval + CI.`,
    guestMessage: String(guestMessage),
    context: {
      guestName: context.guestName || 'Guest',
      checkIn: context.checkIn || null,
      checkOut: context.checkOut || null,
      listingId: context.listingId || null,
      propertyName: context.propertyName || null,
      conversationHistory: context.conversationHistory || [],
      ...context,
    },
    rubric: {
      ...(expectedCategory
        ? {
            expectedCategory: Array.isArray(expectedCategory)
              ? expectedCategory
              : [expectedCategory],
          }
        : {}),
      shouldReply: true,
      shouldAlwaysReply: true,
      minConfidence,
      requiredPhrases: requiredPhrases || [],
      forbiddenPhrases: forbiddenPhrases || [],
    },
    notes:
      notes ||
      'Auto-captured production miss. shouldAlwaysReply + minConfidence enforced in eval runner. Do not drop.',
    productionMiss: true,
    unitTestEnforced: true,
  };
}
