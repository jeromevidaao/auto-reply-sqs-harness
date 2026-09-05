/**
 * Conversation-thread helpers for first-pass, rewrite, and Conversation Judge.
 *
 * Hospitable GET /reservations/{id}/messages (and /conversations/{id}/messages)
 * returns newest-first. Eval fixtures are usually already oldest-first and often
 * have no timestamps. Always normalize live fetches by created_at so the judge
 * sees the real thread instead of slice(-N) of the oldest messages.
 */

export const THREAD_HISTORY_FETCH_LIMIT = 100;
const BODY_CLIP = 2000;

export function messageTimestamp(m = {}) {
  const raw = m.created_at || m.timestamp || m.createdAt || m.sent_at || m.sentAt;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Oldest first. Timestamped lists are sorted. Untimestamped lists are left as-is
 * (eval/simulator chronological fixtures).
 */
export function normalizeThreadChronological(messages = []) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (list.length < 2) return list.slice();

  const timed = list
    .map((m, index) => ({ m, t: messageTimestamp(m), index }))
    .filter((row) => row.t != null);

  if (timed.length >= 2) {
    return list.slice().sort((a, b) => {
      const ta = messageTimestamp(a);
      const tb = messageTimestamp(b);
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      if (ta !== tb) return ta - tb;
      return 0;
    });
  }

  return list.slice();
}

export function speakerLabel(m = {}) {
  const type = m.sender_type || m.sender?.type || '';
  if (String(type).toLowerCase() === 'guest') return 'Guest';
  return 'Host';
}

export function clipMessageBody(body, max = BODY_CLIP) {
  const s = String(body || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

export function formatConversationHistoryLines(messages = [], { clip = BODY_CLIP } = {}) {
  const list = normalizeThreadChronological(Array.isArray(messages) ? messages : []);
  return list.map((m) => {
    const who = speakerLabel(m);
    const body = clipMessageBody(m.body || m.text || '', clip);
    const when = m.created_at || m.timestamp || m.createdAt || m.sent_at;
    return when ? `${who} (${when}): ${body}` : `${who}: ${body}`;
  });
}

export function hasPriorConversation(context = {}) {
  const hist = context.conversationHistory || [];
  if (Array.isArray(hist) && hist.length > 0) return true;
  const traces = context.conversationTraces || {};
  if (traces.priorHostHVACAdvice || traces.repeatedInstructionRisk || traces.recentWelcomeSent) {
    return true;
  }
  if ((traces.recentMessageCount || 0) > 1) return true;
  if (Array.isArray(traces.recentConversationMessages) && traces.recentConversationMessages.length > 0) {
    return true;
  }
  return false;
}
