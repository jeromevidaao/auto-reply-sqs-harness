/**
 * Persist each guest-messaging harness run so the website monitoring page
 * can show answered vs not, duration, category, conversation, and why.
 *
 * Table: guestMessagingRuns
 *   pk = "RUN"
 *   sk = "{ISO}#{runId}"  (lexicographic, Query newest-first)
 *
 * Never throws — monitoring must not break a guest reply.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

export const RUNS_TABLE = process.env.GUEST_MESSAGING_RUNS_TABLE || 'guestMessagingRuns';
export const RUN_PK = 'RUN';
const TTL_DAYS = 180;
const HISTORY_LIMIT = 20;
const BODY_MAX = 1500;
const DRAFT_MAX = 4000;
const WHY_MAX = 1500;
const MSG_MAX = 2000;

let _ddb = null;

function ddbClient() {
  if (_ddb) return _ddb;
  _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }));
  return _ddb;
}

export function clip(str, max) {
  const s = String(str == null ? '' : str);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== '') return v;
  }
  return null;
}

export function clipHistory(raw, limit = HISTORY_LIMIT) {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw.slice(-limit).map((m) => {
    if (m == null) return { role: 'unknown', body: '', at: null, name: null };
    if (typeof m === 'string') return { role: 'unknown', body: clip(m, BODY_MAX), at: null, name: null };
    const role = String(
      pick(m, ['sender_type', 'senderType', 'role', 'from', 'authorRole']) ||
        (m.host === true || m.isHost === true ? 'host' : '') ||
        (m.guest === true || m.isGuest === true ? 'guest' : '') ||
        'unknown'
    ).toLowerCase();
    return {
      role: role === 'owner' ? 'host' : role,
      body: clip(pick(m, ['body', 'message', 'text', 'content']) || '', BODY_MAX),
      at: pick(m, ['created_at', 'createdAt', 'at', 'timestamp', 'sent_at']) || null,
      name: pick(m, ['sender_name', 'senderName', 'name', 'author', 'fromName']) || null,
    };
  });
}

export function resolveOutcome({ result, extra } = {}) {
  const sent = extra?.sent === true || result?.sent === true;
  if (extra?.error) return 'error';
  if (extra?.inquirySendFailed) return 'skipped';
  if (extra?.skipReason && !sent) return 'skipped';
  if (result?.escalated === true) return 'escalated';
  if (sent) return 'sent';
  if (result?.shouldReply === false) return 'no_reply';
  if (extra?.shouldReply === false) return 'no_reply';
  return 'no_reply';
}

export function explainWhy({ result, extra } = {}) {
  if (extra?.error) return clip(`Error: ${extra.error}`, WHY_MAX);
  if (extra?.skipReason) return clip(String(extra.skipReason), WHY_MAX);
  const cat = result?.typeOfMessageReceived || extra?.category || 'UNCATEGORIZED';
  const conf = result?.confidence != null ? ` Confidence ${result.confidence}.` : '';
  const judge =
    result?.conversationJudge?.verdict ||
    result?.conversationJudge?.decision ||
    result?.conversationJudge?.result ||
    null;
  const judgeBit = judge ? ` Judge: ${judge}.` : '';
  const force = result?.replyForceReason ? ` Policy: ${result.replyForceReason}.` : '';
  const heReason = extra?.reason || result?.reason || result?.sendSkipReason || '';
  const heBit = heReason ? ` ${heReason}` : '';
  const sent = extra?.sent === true || result?.sent === true;

  if (extra?.inquirySendFailed) {
    return clip(`Drafted ${cat} but Hospitable inquiry send failed — needs manual send.${conf}${judgeBit}`, WHY_MAX);
  }
  if (result?.escalated === true) {
    const esc = result.escalationReason || result.escalationNotes || extra?.reason || 'Escalated — not auto-sent';
    return clip(`${esc} (${cat}).${conf}${judgeBit}${force}`, WHY_MAX);
  }
  if (sent) {
    return clip(`Answered as ${cat}.${conf}${judgeBit}${force}${heBit}`.replace(/\s+/g, ' ').trim(), WHY_MAX);
  }
  const draft =
    result?.proposedResponse && result.proposedResponse !== 'none'
      ? ' A draft was produced but shouldReply was false.'
      : ' No sendable draft.';
  return clip(
    `Decided not to answer (${cat}).${conf}${judgeBit}${force}${draft}${heBit}`.replace(/\s+/g, ' ').trim(),
    WHY_MAX
  );
}

export function buildRunItem(input) {
  const now = Date.now();
  const startTime = Number(input.startTime) || now;
  const durationMs = Number(input.durationMs != null ? input.durationMs : now - startTime);
  const endedAt = startTime + Math.max(0, durationMs);
  const runId = String(input.requestId || input.runId || `local-${startTime}`);
  const startedIso = new Date(startTime).toISOString();
  const ctx = input.context || {};
  const result = input.result || {};
  const extra = input.extra || {};
  const outcome = resolveOutcome({ result, extra });
  const answered = outcome === 'sent';
  const shouldReply =
    extra.shouldReply != null
      ? !!extra.shouldReply
      : result.shouldReply != null
        ? !!result.shouldReply
        : answered;
  const sent = extra.sent === true || result.sent === true;
  const category =
    extra.category ||
    result.typeOfMessageReceived ||
    result.category ||
    'UNCATEGORIZED';
  const history =
    extra.conversationHistory ||
    result.conversationHistory ||
    ctx.conversationHistory ||
    ctx.messages ||
    [];

  return {
    pk: RUN_PK,
    sk: `${startedIso}#${runId}`,
    runId,
    startedAt: startTime,
    endedAt,
    durationMs,
    outcome,
    answered,
    shouldReply,
    sent,
    category: String(category),
    platform: String(extra.platform || input.platform || ctx.platform || 'airbnb'),
    act: extra.act || input.act || null,
    guestName:
      pick(ctx, ['guestName', 'guest_name']) ||
      pick(ctx.guest || {}, ['name', 'full_name', 'first_name']) ||
      extra.guestName ||
      null,
    guestMessage: clip(input.guestMessage || ctx.body || extra.guestMessage || '', MSG_MAX),
    proposedResponse: clip(
      extra.proposedResponse || result.proposedResponse || '',
      DRAFT_MAX
    ),
    why: explainWhy({ result, extra }),
    conversationHistory: clipHistory(history),
    propertyName:
      pick(ctx, ['propertyName']) ||
      pick(ctx.property || {}, ['name']) ||
      pick(ctx.listing || {}, ['name']) ||
      extra.propertyName ||
      null,
    listingId:
      pick(ctx, ['listingId', 'listing_id']) ||
      pick(ctx.property || {}, ['id']) ||
      extra.listingId ||
      null,
    conversationId:
      pick(ctx, ['conversation_id', 'conversationId', 'airbnb_conversation_id']) ||
      extra.conversationId ||
      null,
    reservationId:
      pick(ctx, ['reservationId', 'reservation_id']) ||
      pick(ctx.reservation || {}, ['id']) ||
      extra.reservationId ||
      null,
    confidence: result.confidence != null ? result.confidence : extra.confidence || null,
    judgeVerdict:
      result.conversationJudge?.verdict ||
      result.conversationJudge?.decision ||
      extra.judgeVerdict ||
      null,
    escalated: !!(result.escalated || extra.escalated),
    error: extra.error ? clip(String(extra.error), 500) : null,
    expiresAt: Math.floor(endedAt / 1000) + TTL_DAYS * 24 * 3600,
  };
}

/**
 * @param {object} input  buildRunItem input
 * @param {{ put?: Function, ddb?: object }} [deps]
 */
export async function persistGuestMessagingRun(input, deps = {}) {
  if (input?.skipPersist) return { skipped: true };
  const item = buildRunItem(input);
  try {
    if (typeof deps.put === 'function') {
      await deps.put(item);
      return { ok: true, item };
    }
    const ddb = deps.ddb || ddbClient();
    await ddb.send(
      new PutCommand({
        TableName: RUNS_TABLE,
        Item: item,
      })
    );
    console.log('[runMonitor] persisted', {
      runId: item.runId,
      outcome: item.outcome,
      category: item.category,
      durationMs: item.durationMs,
    });
    return { ok: true, item };
  } catch (err) {
    console.warn('[runMonitor] persist failed (non-fatal):', err?.message || err);
    return { ok: false, error: err?.message || String(err), item };
  }
}
