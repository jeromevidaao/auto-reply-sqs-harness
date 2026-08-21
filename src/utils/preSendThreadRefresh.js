/**
 * Pre-send thread refresh (Michael 2026-08-21).
 *
 * Processing (LLM + judge) can take long enough that the guest sends more
 * messages — or a sibling Lambda already replied — before we POST.
 * Just before send: GET the live thread. If newer guest messages exist,
 * reprocess once with that context (like a human adjusting while typing).
 * Then skip send if a recent host "You're welcome" is already on the thread.
 */
import { hostAlreadySentEquivalent, looksLikeExistingWelcome } from './httpRetry.js';

export const RECENT_WELCOME_ACK_MS = 10 * 60 * 1000;

export function isGuestMessage(m) {
  const t = String(m?.sender_type || m?.sender?.type || m?.role || '').toLowerCase();
  return t === 'guest';
}

export function isHostMessage(m) {
  const t = String(m?.sender_type || m?.sender?.type || m?.role || '').toLowerCase();
  return t === 'host' || t === 'owner';
}

export function messageBody(m) {
  return String(m?.body || m?.content || '').trim();
}

export function normalizeBody(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function chronologicalThread(messages) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const stamped = list.filter((m) => m?.created_at || m?.created);
  if (stamped.length >= 2) {
    const first = Date.parse(stamped[0].created_at || stamped[0].created);
    const last = Date.parse(stamped[stamped.length - 1].created_at || stamped[stamped.length - 1].created);
    if (Number.isFinite(first) && Number.isFinite(last) && first > last) {
      return list.reverse();
    }
  }
  return list;
}

export function guestMessagesAfter(threadChrono, originalGuestMessage) {
  const orig = normalizeBody(originalGuestMessage);
  if (!orig) return [];
  let idx = -1;
  for (let i = threadChrono.length - 1; i >= 0; i--) {
    if (isGuestMessage(threadChrono[i]) && normalizeBody(messageBody(threadChrono[i])) === orig) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return [];
  return threadChrono.slice(idx + 1).filter(isGuestMessage);
}

export function isBareWelcomeAck(text) {
  let t = String(text || '').trim();
  if (!/you're welcome|you are welcome/i.test(t)) return false;
  t = t.replace(/^good (?:morning|afternoon|evening)[,!\s]*/i, '');
  t = t.replace(/you're welcome|you are welcome/gi, '');
  t = t.replace(/see you soon|see you then/gi, '');
  t = t.replace(/[^a-z]+/gi, ' ').trim();
  if (!t) return true;
  const words = t.split(/\s+/);
  return words.length <= 1 && words[0].length <= 20;
}

export function recentHostWelcomeAck(threadChrono, { withinMs = RECENT_WELCOME_ACK_MS, now = Date.now() } = {}) {
  const hosts = (Array.isArray(threadChrono) ? threadChrono : []).filter(isHostMessage);
  for (let i = hosts.length - 1; i >= 0; i--) {
    const m = hosts[i];
    if (!isBareWelcomeAck(messageBody(m))) continue;
    const ts = Date.parse(m.created_at || m.created || '');
    if (!Number.isFinite(ts)) return true;
    return now - ts <= withinMs;
  }
  return false;
}

export function shouldSkipDuplicateSend(thread, proposedResponse, { now = Date.now() } = {}) {
  const chrono = chronologicalThread(thread);
  const proposed = String(proposedResponse || '').trim();
  if (!proposed || proposed === 'none') return { skip: false };
  // Short you're-welcome: only skip if one landed in the last ~10 min (Michael double-ack).
  // Guests thank us again later in the stay — that must still send.
  if (isBareWelcomeAck(proposed)) {
    if (recentHostWelcomeAck(chrono, { now })) {
      return { skip: true, reason: 'recent_youre_welcome' };
    }
    return { skip: false };
  }
  if (hostAlreadySentEquivalent(chrono, proposed)) {
    return { skip: true, reason: 'equivalent_already_sent' };
  }
  if (looksLikeExistingWelcome(chrono, proposed)) {
    return { skip: true, reason: 'welcome_already_sent' };
  }
  return { skip: false };
}

function toHistory(threadChrono) {
  return threadChrono.map((m) => ({
    sender_type: isGuestMessage(m) ? 'guest' : 'host',
    body: messageBody(m),
    created_at: m.created_at || m.created,
  }));
}

/**
 * @returns {Promise<{ result: object, skipSend: boolean, reprocessed: boolean, reason?: string }>}
 */
export async function runPreSendThreadRefresh({
  hospitableClient,
  reservationId,
  conversationId,
  isInquiry,
  originalGuestMessage,
  originalResult,
  context = {},
  reprocess,
  alreadyReprocessed = false,
  now = Date.now(),
} = {}) {
  const result0 = originalResult || {};
  if (!hospitableClient || typeof hospitableClient.getThreadMessages !== 'function') {
    return { result: result0, skipSend: false, reprocessed: false };
  }

  const fetchThread = () =>
    hospitableClient.getThreadMessages(
      { reservationId, conversationId, isInquiry },
      20
    );

  let thread;
  try {
    thread = await fetchThread();
  } catch (err) {
    console.warn('[preSend] thread fetch failed (proceeding with original draft):', err?.message || err);
    return { result: result0, skipSend: false, reprocessed: false };
  }

  const chrono = chronologicalThread(thread);
  const newer = guestMessagesAfter(chrono, originalGuestMessage);
  let result = result0;
  let reprocessed = false;

  if (
    newer.length > 0 &&
    !alreadyReprocessed &&
    !context._preSendReprocessed &&
    typeof reprocess === 'function'
  ) {
    const latest = newer[newer.length - 1];
    const latestBody = messageBody(latest);
    console.log(
      `[preSend] ${newer.length} newer guest message(s) arrived while drafting; reprocessing latest: "${latestBody.slice(0, 80)}"`
    );
    try {
      result = await reprocess(latestBody, {
        ...context,
        conversationHistory: toHistory(chrono),
        _preSendReprocessed: true,
        preSendOriginalGuestMessage: originalGuestMessage,
        preSendNewerGuestMessages: newer.map(messageBody),
        preSendStaleDraft: result0.proposedResponse || '',
      });
      reprocessed = true;
    } catch (err) {
      console.warn('[preSend] reprocess failed (keeping original draft):', err?.message || err);
      result = result0;
    }
  }

  const sendable =
    result?.shouldReply &&
    result.proposedResponse &&
    result.proposedResponse !== 'none' &&
    !result.escalated;
  if (!sendable) {
    return { result, skipSend: false, reprocessed };
  }

  let threadForDup = chrono;
  if (reprocessed) {
    try {
      threadForDup = chronologicalThread(await fetchThread());
    } catch {
      threadForDup = chrono;
    }
  }

  const dup = shouldSkipDuplicateSend(threadForDup, result.proposedResponse, { now });
  if (dup.skip) {
    console.log(`[preSend] skip send — ${dup.reason}`);
    return { result, skipSend: true, reprocessed, reason: dup.reason };
  }

  return { result, skipSend: false, reprocessed, thread: threadForDup };
}
