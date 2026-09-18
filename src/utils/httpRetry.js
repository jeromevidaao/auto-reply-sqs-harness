/**
 * Shared HTTP retry helpers for Hospitable (and similar) API calls.
 *
 * Two-layer retry (Julie 2026-08-13 + follow-up):
 *   1) In-Lambda: 4 POSTs over ~3 min (20s timeout, exp backoff 30/30/40s).
 *   2) SQS grok_message: 4 receives, 12 min visibility → ~36–40 min, then DLQ.
 *
 * HomeExchange + Hospitable calendar writes use kind='write':
 *   4 attempts, 15s timeout, exp backoff 5/15/30s (~1 min). Approve/send
 *   GET-confirm after timeout so a landed call is not repeated.
 *
 * Production incident 2026-08-13 (Julie / Apt 2 welcome):
 *   POST /reservations/{id}/messages timed out at 15s, then in-Lambda retries
 *   at 5s/10s/20s hit Hospitable's **2 POSTs per minute per reservation** cap
 *   (HTTP 429). SQS then re-ran the whole Lambda 5 times → DLQ alarm.
 *
 * Rules:
 *   - Only retry transient failures (timeouts, 429, 5xx, network).
 *   - Honor Retry-After on 429 when it is at least the kind floor; never honor 0
 *     (Hospitable often sends Retry-After: 0 after the first 429 — Amber 2026-08-17).
 *     Default 60s for message POSTs / reads when header is missing or too small.
 *   - On 429, also apply attempt-based exponential floor so a flat Retry-After
 *     (Carli 2026-09-18 ~20–26s) still escalates across retries.
 *   - Message POSTs must stay under 2/min (min spacing 30s).
 *   - After a send timeout, callers should GET the thread before POSTing again
 *     (timeout ≠ not delivered).
 *   - Do not sit in the Lambda for 10+ minutes — leave long waits to SQS.
 */

export const HOSPITABLE_SEND_TIMEOUT_MS = 20000;
export const HOSPITABLE_READ_TIMEOUT_MS = 12000;
export const HOSPITABLE_SEND_MIN_INTERVAL_MS = 30000;
export const HOSPITABLE_SEND_MAX_ATTEMPTS = 4;
export const HOSPITABLE_READ_MAX_ATTEMPTS = 4;
export const HOSPITABLE_429_DEFAULT_MS = 60000;
/** Floor for GET/read 429s. Hospitable often sends Retry-After: 0 after the first 429. */
export const HOSPITABLE_READ_429_MIN_MS = 15000;

/** HE + calendar writes: 4 attempts, exp backoff 5/15/30s (~50s waits, ~1 min). */
export const WRITE_MAX_ATTEMPTS = 4;
export const WRITE_BACKOFF_MS = [5000, 15000, 30000];
export const WRITE_429_DEFAULT_MS = 15000;
export const WRITE_429_CAP_MS = 45000;
export const HE_MAX_ATTEMPTS = WRITE_MAX_ATTEMPTS;
export const HE_TIMEOUT_MS = 15000;

/** SQS grok_message: 4 receives × 12 min visibility ≈ 36–40 min then DLQ. */
export const GROK_MESSAGE_VISIBILITY_TIMEOUT_SEC = 720;
export const GROK_MESSAGE_MAX_RECEIVE_COUNT = 4;

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_NETWORK',
  'ERR_CANCELED',
]);

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientHttpError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.permanent === true || err.noRetry === true) return false;
  const status = err.response?.status ?? err.status ?? err.$metadata?.httpStatusCode;
  if (status === 429 || status === 408) return true;
  if (typeof status === 'number' && status >= 500) return true;
  if (status && status < 500) return false;

  const awsName = String(err.name || '');
  if (/Throttling|ProvisionedThroughputExceeded|TimeoutError|RequestTimeout|ServiceUnavailable|InternalServerError/i.test(awsName)) {
    return true;
  }
  if (/ResourceNotFound|AccessDenied|ValidationException|ConditionalCheckFailed|UnrecognizedClient/i.test(awsName)) {
    return false;
  }

  const code = err.code || err.cause?.code;
  if (code && TRANSIENT_CODES.has(String(code))) return true;

  const msg = String(err.message || '');
  if (/timeout of \d+ms exceeded/i.test(msg)) return true;
  if (/socket hang up/i.test(msg)) return true;
  if (/network\s?error/i.test(msg)) return true;
  if (/ECONNRESET|ETIMEDOUT|ECONNABORTED/i.test(msg)) return true;
  return !status;
}

/**
 * Parse Retry-After (seconds or HTTP-date) from an axios-like error.
 * @returns {number|null} delay in ms
 */
export function parseRetryAfterMs(err) {
  const headers = err?.response?.headers;
  if (!headers) return null;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw == null || raw === '') return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.round(asNum * 1000);
  const when = Date.parse(String(raw));
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.attempt] 1-based attempt that just failed
 * @param {'send'|'read'} [opts.kind]
 * @param {(min: number, max: number) => number} [opts.random]
 */
export function computeRetryDelay(err, opts = {}) {
  const attempt = Math.max(1, opts.attempt || 1);
  const kind = opts.kind || 'read';
  const random = opts.random || Math.random;
  const jitter = opts.jitter !== false;

  const status = err?.response?.status ?? err?.status;
  let delay;
  if (status === 429) {
    const fallback = kind === 'write' ? WRITE_429_DEFAULT_MS : HOSPITABLE_429_DEFAULT_MS;
    const minFloor =
      kind === 'write'
        ? WRITE_429_DEFAULT_MS
        : kind === 'send'
          ? HOSPITABLE_SEND_MIN_INTERVAL_MS
          : HOSPITABLE_READ_429_MIN_MS;
    const parsed = parseRetryAfterMs(err);
    // Retry-After: 0 / past HTTP-date / tiny values are not usable — Hospitable
    // sent 0 on subsequent 429s and we burned 4 GET attempts in ~29s (Amber).
    const fromHeader = parsed != null && parsed >= minFloor ? parsed : 0;
    // Exp schedule always applies as a floor so flat Retry-After (Carli ~20–26s)
    // still escalates across attempts instead of waiting the same delay forever.
    const exp429 =
      kind === 'write'
        ? WRITE_BACKOFF_MS[Math.min(attempt - 1, WRITE_BACKOFF_MS.length - 1)]
        : kind === 'send'
          ? [30000, 30000, 40000][Math.min(attempt - 1, 2)]
          : [15000, 30000, 60000, 60000][Math.min(attempt - 1, 3)];
    delay = Math.max(exp429, fromHeader || fallback, minFloor);
    if (kind === 'write') {
      delay = Math.min(delay, WRITE_429_CAP_MS);
    }
    if (kind === 'read') {
      delay = Math.min(delay, 90000);
    }
  } else if (kind === 'send') {
    // After fail 1/2/3: 20s, 30s, 40s — then clamped to the 2/min floor (30s).
    // Worst case with 20s timeouts: ~3 min in-Lambda, then SQS waits ~12 min.
    const sendBackoff = [20000, 30000, 40000];
    delay = sendBackoff[Math.min(attempt - 1, sendBackoff.length - 1)];
  } else if (kind === 'write') {
    // HE approve/send + Hospitable calendar PUT: 4 tries over ~1 min.
    delay = WRITE_BACKOFF_MS[Math.min(attempt - 1, WRITE_BACKOFF_MS.length - 1)];
  } else {
    const readBackoff = [2000, 4000, 8000, 16000];
    delay = readBackoff[Math.min(attempt - 1, readBackoff.length - 1)];
  }

  if (kind === 'send') {
    delay = Math.max(delay, HOSPITABLE_SEND_MIN_INTERVAL_MS);
  }

  if (jitter) {
    const factor = 0.85 + random() * 0.3;
    delay = Math.round(delay * factor);
  }
  return delay;
}

export function makeCriticalHttpError(operation, attempt, err, isTransient) {
  const status = err?.response?.status;
  const message =
    `CRITICAL HOSPITABLE API FAILURE: ${operation} failed after ${attempt} attempt(s). ` +
    `Last error: ${err?.message || err}` +
    (status ? ` (status ${status})` : '');
  const criticalError = new Error(message);
  criticalError.name = 'CriticalHospitableError';
  criticalError.operation = operation;
  criticalError.attempts = attempt;
  criticalError.originalError = err;
  criticalError.isTransient = !!isTransient;
  return criticalError;
}

/**
 * Retry `fn` with exponential backoff. `recover(err, attempt)` may return a
 * value to treat the failure as success (e.g. message already on the thread).
 */
export async function withExponentialBackoff(fn, options = {}) {
  const {
    operation = 'http',
    maxAttempts = HOSPITABLE_READ_MAX_ATTEMPTS,
    kind = 'read',
    recover,
    sleeper = (ms) => new Promise((r) => setTimeout(r, ms)),
    random,
    jitter,
    onRetry,
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (typeof recover === 'function') {
        try {
          const recovered = await recover(err, attempt);
          if (recovered !== undefined && recovered !== null && recovered !== false) {
            console.warn(
              `[httpRetry] ${operation} attempt ${attempt} failed (${err.message}); recover confirmed success`
            );
            return recovered;
          }
        } catch (recoverErr) {
          console.warn(
            `[httpRetry] recover failed for ${operation} after attempt ${attempt}:`,
            recoverErr?.message || recoverErr
          );
        }
      }

      const transient = isTransientHttpError(err);
      if (!transient || attempt === maxAttempts) {
        throw makeCriticalHttpError(operation, attempt, err, transient);
      }

      let delay = computeRetryDelay(err, { attempt, kind, random, jitter });
      if (!Number.isFinite(delay) || delay < 1) {
        delay = computeRetryDelay(err, { attempt, kind, random, jitter: false });
        delay = Math.max(delay, 1000);
      }
      const retryAfterMs = parseRetryAfterMs(err);
      const msg =
        `[httpRetry] Transient error on ${operation} (attempt ${attempt}/${maxAttempts}). ` +
        `Retrying in ${delay}ms (Retry-After=${retryAfterMs == null ? 'none' : `${retryAfterMs}ms`})... ` +
        `Error: ${err.message}`;
      console.warn(msg);
      if (typeof onRetry === 'function') onRetry({ attempt, delay, err, retryAfterMs });
      await sleeper(delay);
    }
  }
  throw makeCriticalHttpError(operation, maxAttempts, lastError, true);
}

function isHostMessage(m) {
  return m && (m.sender_type === 'host' || m.sender?.type === 'host' || m.sender_type === 'owner');
}

function messageBody(m) {
  return String(m?.body || '').trim();
}

/**
 * True if a recent host message already matches the draft we are about to send
 * (exact, or prefix overlap after a timeout-then-retry).
 */
export function hostAlreadySentEquivalent(messages, body) {
  if (!body || typeof body !== 'string') return false;
  const list = Array.isArray(messages) ? messages : [];
  const full = body.trim().toLowerCase();
  if (!full) return false;
  const needle = full.slice(0, 80);
  return list.some((m) => {
    if (!isHostMessage(m)) return false;
    const t = messageBody(m).toLowerCase();
    if (!t) return false;
    if (t === full) return true;
    if (needle.length >= 24 && t.includes(needle.slice(0, 60))) return true;
    if (full.length >= 40 && full.includes(t.slice(0, 60)) && t.length >= 40) return true;
    return false;
  });
}

/**
 * Welcome-specific: a recent host message already delivered the 4pm +
 * self-check-in logistics even if the new draft wording differs (SQS retry
 * after a timeout that actually landed).
 */
export function looksLikeExistingWelcome(messages, proposedResponse) {
  if (hostAlreadySentEquivalent(messages, proposedResponse)) return true;
  const proposed = String(proposedResponse || '').toLowerCase();
  const isWelcomeDraft = /4\s*pm/.test(proposed) && /self-check-?in/.test(proposed);
  if (!isWelcomeDraft) return false;
  const list = Array.isArray(messages) ? messages : [];
  return list.some((m) => {
    if (!isHostMessage(m)) return false;
    const t = messageBody(m).toLowerCase();
    return /4\s*pm/.test(t) && /self-check-?in/.test(t);
  });
}
