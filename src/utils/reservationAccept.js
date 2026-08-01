/**
 * Detect pending → just-accepted reservation transitions from Hospitable payloads.
 *
 * Used for natural welcome openers like "I just accepted your inquiry" (request-to-book
 * accept), and to avoid that phrasing on instant-book (accepted with no prior pending).
 */

/** Default: treat accept as "just now" if within this many ms of process/webhook time. */
export const DEFAULT_JUST_ACCEPTED_WINDOW_MS = 5 * 60 * 1000;

const PENDING_CATEGORIES = new Set([
  'request',
  'pending',
  'checkpoint',
  'not accepted',
  'not_accepted',
]);

const PENDING_SUBCATEGORIES = [
  'request to book',
  'request for payment',
  'awaiting approval',
  'pending verification',
];

/**
 * Canonical accept opener when we host-accepted a pending inquiry/request.
 * Keep stable for evals; LLM may soft-paraphrase slightly but policy re-enforces.
 */
export const JUST_ACCEPTED_INQUIRY_OPENER = 'I just accepted your inquiry';

/**
 * @param {object} reservation - Hospitable reservation object (webhook data or GET /reservations/{id})
 * @param {object} [options]
 * @param {number} [options.windowMs]
 * @param {Date|string|number} [options.now] - clock for tests
 * @returns {{
 *   currentCategory: string|null,
 *   isAccepted: boolean,
 *   wasPendingBeforeAccept: boolean,
 *   isInstantBookStyle: boolean,
 *   acceptedAt: string|null,
 *   acceptedAtMs: number|null,
 *   justAccepted: boolean,
 *   justAcceptedFromPending: boolean,
 *   justAcceptedInquiry: boolean,
 *   history: Array<object>,
 * }}
 */
export function analyzeReservationAccept(reservation = {}, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_JUST_ACCEPTED_WINDOW_MS;
  const nowMs = options.now != null ? new Date(options.now).getTime() : Date.now();

  const history = normalizeHistory(reservation);
  const currentCategory = extractCurrentCategory(reservation, history);
  const isAccepted = isAcceptedCategory(currentCategory);

  const acceptedEntry = findLatestAcceptedEntry(history);
  const acceptedAt = acceptedEntry?.changed_at || acceptedEntry?.changedAt || null;
  const acceptedAtMs = acceptedAt ? Date.parse(acceptedAt) : NaN;
  const hasValidAcceptedAt = Number.isFinite(acceptedAtMs);

  const wasPendingBeforeAccept = historyHasPendingBeforeAccepted(history);
  // Instant book / direct accept: accepted with no prior request/pending in history
  const isInstantBookStyle = isAccepted && !wasPendingBeforeAccept;

  const justAccepted =
    isAccepted &&
    hasValidAcceptedAt &&
    nowMs - acceptedAtMs >= 0 &&
    nowMs - acceptedAtMs <= windowMs;

  // Also allow missing history timestamp but webhook action is clearly a fresh accept change
  // (caller can pass options.forceJustAccepted from action + status).
  const justAcceptedFromPending =
    (justAccepted && wasPendingBeforeAccept) ||
    (!!options.forceJustAcceptedFromPending && wasPendingBeforeAccept && isAccepted);

  return {
    currentCategory,
    isAccepted,
    wasPendingBeforeAccept,
    isInstantBookStyle,
    acceptedAt: acceptedAt || null,
    acceptedAtMs: hasValidAcceptedAt ? acceptedAtMs : null,
    justAccepted,
    justAcceptedFromPending,
    /** Alias used on agent context / prompts */
    justAcceptedInquiry: justAcceptedFromPending,
    history,
  };
}

/**
 * True when this SQS/API envelope is a reservation lifecycle webhook (not a chat message).
 */
export function isReservationLifecyclePayload(outer = {}, context = {}) {
  const act =
    outer?.queryStringParameters?.act ||
    outer?.multiValueQueryStringParameters?.act?.[0] ||
    context?.act ||
    null;
  if (String(act || '').toLowerCase() === 'reservation') return true;

  const action = String(context?.action || outer?.action || '').toLowerCase();
  if (action.startsWith('reservation.')) return true;

  // Webhook body already parsed into context with reservation-shaped fields and no chat body
  if (
    context?.reservation_status &&
    (context?.check_in || context?.checkIn) &&
    !context?.body &&
    (context?.id || context?.reservationId)
  ) {
    // Heuristic: full reservation object without message body
    return true;
  }
  return false;
}

export function extractReservationIdFromLifecycle(context = {}) {
  return (
    context.reservationId ||
    context.reservation_id ||
    context.reservation?.id ||
    // On reservation webhooks, data.id is the reservation UUID
    (context.action && String(context.action).startsWith('reservation.') ? context.id : null) ||
    null
  );
}

/**
 * Whether we should run the accept-welcome auto-reply for this lifecycle event.
 * Instant book is intentionally excluded from the "I just accepted your inquiry" path
 * (guest message.created usually handles that welcome).
 */
export function shouldProcessAcceptWelcome(analysis, options = {}) {
  if (!analysis?.isAccepted) return false;
  if (analysis.isInstantBookStyle && !options.allowInstantBook) return false;
  if (!analysis.justAcceptedFromPending && !options.allowStaleAccept) return false;
  return true;
}

function extractCurrentCategory(reservation, history) {
  const fromStatus =
    reservation?.reservation_status?.current?.category ||
    reservation?.reservationStatus?.current?.category ||
    reservation?.reservationStatus ||
    reservation?.status ||
    null;
  if (fromStatus) return String(fromStatus).toLowerCase().trim();
  if (history.length) {
    const last = history[history.length - 1];
    return String(last.category || last.status || '').toLowerCase().trim() || null;
  }
  return null;
}

function isAcceptedCategory(category) {
  const c = String(category || '').toLowerCase().trim();
  return c === 'accepted' || c === 'confirmed';
}

function normalizeHistory(reservation) {
  const raw =
    reservation?.reservation_status?.history ||
    reservation?.reservationStatus?.history ||
    reservation?.status_history ||
    reservation?.statusHistory ||
    [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((h) => ({
      category: String(h?.category || h?.status || '').toLowerCase().trim(),
      sub_category: String(h?.sub_category || h?.subCategory || '').toLowerCase().trim(),
      changed_at: h?.changed_at || h?.changedAt || null,
    }))
    .filter((h) => h.category);
}

function findLatestAcceptedEntry(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (isAcceptedCategory(history[i].category)) return history[i];
  }
  return null;
}

function isPendingEntry(entry) {
  if (!entry) return false;
  if (PENDING_CATEGORIES.has(entry.category)) return true;
  if (PENDING_SUBCATEGORIES.some((s) => entry.sub_category.includes(s))) return true;
  if (entry.category.includes('request') || entry.category.includes('pending')) return true;
  return false;
}

function historyHasPendingBeforeAccepted(history) {
  if (!history.length) return false;
  let sawPending = false;
  for (const entry of history) {
    if (isPendingEntry(entry)) sawPending = true;
    if (isAcceptedCategory(entry.category) && sawPending) return true;
  }
  // Pending appears anywhere and current/last is accepted
  const hasPending = history.some(isPendingEntry);
  const hasAccepted = history.some((h) => isAcceptedCategory(h.category));
  return hasPending && hasAccepted;
}

/**
 * Ensure draft starts with a natural accept acknowledgment (after optional time greeting).
 */
export function ensureJustAcceptedOpener(proposedResponse = '', guestName = '') {
  const draft = (proposedResponse || '').toString().trim();
  const opener = JUST_ACCEPTED_INQUIRY_OPENER;
  if (!draft || draft === 'none') {
    const name = (guestName || '').split(/[\s(·]/)[0] || '';
    const prefix = name ? `${name}, ` : '';
    return `${prefix}${opener}. Looking forward to hosting you!`;
  }
  if (new RegExp(opener.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(draft)) {
    return draft;
  }
  // Insert after "Good morning, Name," / "Hi Name," if present; else prefix.
  const greetingMatch = draft.match(
    /^(Good (?:morning|afternoon|evening),\s*[^,.\n]+[,!]?\s*|Hi\s+[^,.\n]+[,!]?\s*|Hello\s+[^,.\n]+[,!]?\s*)/i
  );
  if (greetingMatch) {
    const rest = draft.slice(greetingMatch[0].length).replace(/^\s+/, '');
    return `${greetingMatch[0]}${opener}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  }
  return `${opener}. ${draft}`;
}
