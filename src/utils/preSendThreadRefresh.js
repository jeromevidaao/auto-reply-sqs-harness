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
/**
 * Always GET the live thread before POST (reuseMaxAgeMs = 0).
 * Carlos 2026-08-28: the in-flight invoke must see the sibling guest
 * message that arrived during the ~100s draft. Concurrent Lambdas on the
 * same reservation are now dropped at the DDB lock, so this extra GET
 * does not stampede Hospitable.
 */
export const PRE_SEND_REUSE_MAX_AGE_MS = 0;

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

/**
 * Host messages that landed AFTER the guest message we started answering.
 * Mid-compose host replies (e.g. Jerome granting a one-time laundry exception)
 * must force reprocess — same as newer guest messages (Sara laundry incident).
 */
export function hostMessagesAfter(threadChrono, originalGuestMessage) {
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
  return threadChrono.slice(idx + 1).filter(isHostMessage);
}

export function looksLikeWelcomeAck(text) {
  return /you're welcome|you are welcome/i.test(String(text || ''));
}

export function isBareWelcomeAck(text) {
  let t = String(text || '').trim();
  if (!looksLikeWelcomeAck(t)) return false;
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
    // Any recent "you're welcome" — not only the short ack. Carlos 2026-08-28
    // first send was "You're welcome! So glad you had a five-star stay…"
    // which isBareWelcomeAck would miss, so the sibling then sent another.
    if (!looksLikeWelcomeAck(messageBody(m))) continue;
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
  // Thank-you ack: skip if a host you're-welcome landed in the last ~10 min
  // (Michael double-ack / Carlos five-star + thanks). A thanks hours later still sends.
  if (looksLikeWelcomeAck(proposed)) {
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
  existingThread = null,
  liveFetchedAt = null,
  reuseMaxAgeMs = PRE_SEND_REUSE_MAX_AGE_MS,
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

  const cached = Array.isArray(existingThread) ? existingThread : null;
  const ageMs =
    liveFetchedAt != null && Number.isFinite(Number(liveFetchedAt))
      ? now - Number(liveFetchedAt)
      : Infinity;
  const canReuse = cached && ageMs >= 0 && ageMs <= reuseMaxAgeMs;

  let thread;
  let reusedLiveThread = false;
  try {
    if (canReuse) {
      thread = cached;
      reusedLiveThread = true;
      console.log(
        `[preSend] reusing live thread from ${Math.round(ageMs)}ms ago (${cached.length} msgs) — skip GET`
      );
    } else {
      thread = await fetchThread();
    }
  } catch (err) {
    console.warn('[preSend] thread fetch failed (proceeding with original draft):', err?.message || err);
    return { result: result0, skipSend: false, reprocessed: false };
  }

  const chrono = chronologicalThread(thread);
  const newerGuest = guestMessagesAfter(chrono, originalGuestMessage);
  const newerHost = hostMessagesAfter(chrono, originalGuestMessage);
  let result = result0;
  let reprocessed = false;

  // Mid-compose: any new guest OR host message (e.g. Jerome granting a laundry
  // exception while we were drafting Soap Bubble) must force reprocess + history refetch.
  if (
    (newerGuest.length > 0 || newerHost.length > 0) &&
    !alreadyReprocessed &&
    !context._preSendReprocessed &&
    typeof reprocess === 'function'
  ) {
    // Prefer the newest guest turn when present; otherwise re-answer the original
    // guest message with the refreshed history that now includes the new host reply.
    const latestGuest = newerGuest.length ? newerGuest[newerGuest.length - 1] : null;
    const latestBody = latestGuest ? messageBody(latestGuest) : originalGuestMessage;
    const reasonBits = [];
    if (newerGuest.length) reasonBits.push(`${newerGuest.length} newer guest`);
    if (newerHost.length) reasonBits.push(`${newerHost.length} newer host`);
    console.log(
      `[preSend] ${reasonBits.join(' + ')} message(s) arrived while drafting; reprocessing with refreshed history. latestGuest="${String(latestBody).slice(0, 80)}"`
    );
    if (newerHost.length) {
      console.log(
        `[preSend] newer host message(s): ${newerHost.map((m) => `"${messageBody(m).slice(0, 60)}"`).join('; ')}`
      );
    }
    try {
      result = await reprocess(latestBody, {
        ...context,
        conversationHistory: toHistory(chrono),
        _preSendReprocessed: true,
        preSendOriginalGuestMessage: originalGuestMessage,
        preSendNewerGuestMessages: newerGuest.map(messageBody),
        preSendNewerHostMessages: newerHost.map(messageBody),
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
    return { result, skipSend: false, reprocessed, reusedLiveThread };
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
    return { result, skipSend: true, reprocessed, reason: dup.reason, reusedLiveThread };
  }

  return { result, skipSend: false, reprocessed, thread: threadForDup, reusedLiveThread };
}
