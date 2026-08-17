/**
 * HomeExchange inbox client for the isolated HE auto-reply use case.
 * Never used by the Airbnb / Hospitable send path.
 *
 * Auth: SSM /homeexchange/bearer-token (same token as cleaningbutton-api HE chat).
 */
import axios from 'axios';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { anyExchangeApproved } from './homeExchangeExchange.js';
import {
  HE_MAX_ATTEMPTS,
  HE_TIMEOUT_MS,
  withExponentialBackoff,
} from '../utils/httpRetry.js';

const ssm = new SSMClient({ region: 'us-east-1' });
const HE_API_BASE = process.env.HE_API_BASE || 'https://api.homeexchange.com';
const HE_TOKEN_SSM = process.env.HE_BEARER_SSM || '/homeexchange/bearer-token';
const HE_WEB_VERSION = process.env.HE_WEB_VERSION || '20.29.1-rc.1';

let _tokenCache = null;

async function _loadToken() {
  if (process.env.HOMEEXCHANGE_BEARER_TOKEN) {
    return process.env.HOMEEXCHANGE_BEARER_TOKEN;
  }
  if (_tokenCache) return _tokenCache;
  const delays = [2000, 4000, 8000];
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await ssm.send(
        new GetParameterCommand({ Name: HE_TOKEN_SSM, WithDecryption: true })
      );
      _tokenCache = response.Parameter.Value;
      return _tokenCache;
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = delays[attempt - 1];
      console.warn(
        `[HomeExchangeClient] SSM token fetch failed (attempt ${attempt}). Retrying in ${delay}ms...`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  const criticalErr = new Error(
    `CRITICAL: Failed to fetch HomeExchange token from SSM after ${maxAttempts} attempts. ${lastErr?.message || lastErr}`
  );
  criticalErr.name = 'CriticalHttpError';
  criticalErr.originalError = lastErr;
  criticalErr.permanent = false;
  throw criticalErr;
}

export function alreadySentEquivalent(messages, proposedResponse) {
  const proposed = String(proposedResponse || '').trim().toLowerCase();
  if (!proposed) return false;
  const preview = proposed.slice(0, 80);
  const list = Array.isArray(messages) ? messages : [];
  const proposedIsFeeAsk = /cleaning fee/.test(proposed) && /after your stay/.test(proposed);
  const proposedIsDecline =
    /those dates are not open/.test(proposed) && /can'?t accept the request/.test(proposed);
  const proposedIsPreapprove = /blocked those dates/.test(proposed);
  return list.some((m) => {
    const text = String(m.content || m.body || m.text || '').trim().toLowerCase();
    if (!text) return false;
    if (text === proposed) return true;
    if (proposedIsPreapprove) {
      return /blocked those dates/.test(text) && /pre-approval/.test(text);
    }
    if (text.includes(preview) || proposed.includes(text.slice(0, 80))) return true;
    // Only the first-message fee-after-stay ask is equivalent to another fee ask.
    // A later "fee is fine + extra dates" reply must still send.
    if (proposedIsFeeAsk && /cleaning fee/.test(text) && /after your stay/.test(text)) {
      return true;
    }
    if (
      proposedIsDecline &&
      /those dates are not open/.test(text) &&
      /can'?t accept the request/.test(text)
    ) {
      return true;
    }
    if (/pre-approval/.test(proposed) && /blocked those dates/.test(proposed)
      && /pre-approval/.test(text) && /blocked those dates/.test(text)) {
      return true;
    }
    return false;
  });
}

export class HomeExchangeClient {
  constructor({ token, http, sleeper } = {}) {
    this._injectedToken = token || null;
    this._http = http || axios;
    this._sleeper = sleeper;
  }

  async getToken() {
    if (this._injectedToken) return this._injectedToken;
    return _loadToken();
  }

  async _withRetry(operation, fn, extras = {}) {
    return withExponentialBackoff(fn, {
      operation,
      kind: extras.kind || 'write',
      maxAttempts: extras.maxAttempts || HE_MAX_ATTEMPTS,
      recover: extras.recover,
      sleeper: extras.sleeper || this._sleeper,
    });
  }

  _headers(token) {
    return {
      Accept: 'application/json',
      'Accept-Language': 'en',
      'Content-Type': 'application/json',
      authorization: `Bearer ${token}`,
      he_web_version: HE_WEB_VERSION,
      origin: 'https://www.homeexchange.com',
      referer: 'https://www.homeexchange.com/conversations',
      'User-Agent': 'guest-messaging-agent-harness-homeexchange/1.0',
    };
  }

  _conversationField(conversationId) {
    const s = String(conversationId);
    return /^\d+$/.test(s) ? parseInt(s, 10) : conversationId;
  }

  async listMessages(conversationId) {
    if (!conversationId) throw new Error('conversationId is required');
    const token = await this.getToken();
    return this._withRetry('heListMessages', async () => {
      const response = await this._http.get(`${HE_API_BASE}/v3/messages`, {
        headers: this._headers(token),
        params: { conversation_id: conversationId },
        timeout: HE_TIMEOUT_MS,
      });
      return (
        response.data?.data?.messages ||
        response.data?.messages ||
        []
      );
    });
  }

  async sendMessage(conversationId, content) {
    if (!conversationId) throw new Error('conversationId is required to send a HomeExchange message');
    if (!content || typeof content !== 'string') throw new Error('content must be a non-empty string');
    const token = await this.getToken();
    const recover = async (err) => {
      try {
        const messages = await this.listMessages(conversationId);
        if (alreadySentEquivalent(messages, content)) {
          console.warn(
            `[HomeExchangeClient] send failed (${err?.message || err}) but draft is already on the thread`
          );
          return { alreadyDelivered: true, recoveredFrom: err?.message };
        }
      } catch (fetchErr) {
        console.warn(
          '[HomeExchangeClient] post-failure thread check failed:',
          fetchErr?.message || fetchErr
        );
      }
      return false;
    };
    return this._withRetry(
      'heSendMessage',
      async () => {
        const response = await this._http.post(
          `${HE_API_BASE}/v1/messages`,
          { content, conversation: this._conversationField(conversationId) },
          { headers: this._headers(token), timeout: HE_TIMEOUT_MS }
        );
        return response.data || { ok: true };
      },
      { recover }
    );
  }

  async getConversation(conversationId) {
    if (!conversationId) throw new Error('conversationId is required');
    const token = await this.getToken();
    return this._withRetry('heGetConversation', async () => {
      const response = await this._http.get(
        `${HE_API_BASE}/v3/conversations/me/${encodeURIComponent(conversationId)}`,
        { headers: this._headers(token), timeout: HE_TIMEOUT_MS }
      );
      const data = response.data?.data || response.data || {};
      return data.conversation || data;
    });
  }

  /**
   * Home calendar as [start_on, end_on) ranges.
   * Live types: NON_RECIPROCAL (open for GP stays), RESERVED (blocked / booked).
   * Nights not covered by any range are closed (owner long-block).
   */
  async getHomeCalendar(homeId) {
    if (!homeId) throw new Error('homeId is required');
    const token = await this.getToken();
    return this._withRetry('heGetHomeCalendar', async () => {
      const response = await this._http.get(
        `${HE_API_BASE}/v1/homes/${encodeURIComponent(homeId)}/calendar`,
        { headers: this._headers(token), timeout: HE_TIMEOUT_MS }
      );
      const payload = response.data;
      if (Array.isArray(payload?.data)) return payload.data;
      if (Array.isArray(payload)) return payload;
      return [];
    });
  }

  /**
   * Exchanges for a conversation (array). Approve uses this same array as the body.
   */
  async getExchangesForConversation(conversationId) {
    if (!conversationId) throw new Error('conversationId is required');
    const token = await this.getToken();
    return this._withRetry('heGetExchanges', async () => {
      const response = await this._http.get(
        `${HE_API_BASE}/v1/exchanges/${encodeURIComponent(conversationId)}/get-exchanges`,
        { headers: this._headers(token), timeout: HE_TIMEOUT_MS }
      );
      const data = response.data;
      return Array.isArray(data) ? data : data?.data || [];
    });
  }

  /**
   * Host pre-approve (the orange Pre-approve button).
   * PATCH /v1/exchanges/{conversationId}/approve with the get-exchanges array.
   * Using the exchange id in the URL is a 400 PHP "Undefined offset: 0".
   */
  async approveConversation(conversationId) {
    if (!conversationId) throw new Error('conversationId is required');
    const token = await this.getToken();
    const recover = async (err) => {
      try {
        const current = await this.getExchangesForConversation(conversationId);
        if (anyExchangeApproved(current)) {
          console.warn(
            `[HomeExchangeClient] approve failed (${err?.message || err}) but exchange is already pre-approved`
          );
          return { alreadyApproved: true, recovered: true, exchanges: current };
        }
      } catch (fetchErr) {
        console.warn(
          '[HomeExchangeClient] approve recover get-exchanges failed:',
          fetchErr?.message || fetchErr
        );
      }
      return false;
    };
    return this._withRetry(
      'heApproveConversation',
      async () => {
        const exchanges = await this.getExchangesForConversation(conversationId);
        if (!exchanges.length) {
          const err = new Error('no exchanges on conversation');
          err.permanent = true;
          throw err;
        }
        if (anyExchangeApproved(exchanges)) {
          return { alreadyApproved: true, exchanges };
        }
        const response = await this._http.patch(
          `${HE_API_BASE}/v1/exchanges/${encodeURIComponent(conversationId)}/approve`,
          exchanges,
          { headers: this._headers(token), timeout: HE_TIMEOUT_MS }
        );
        return response.data || { ok: true };
      },
      { recover }
    );
  }

  /** @deprecated use approveConversation */
  async approveExchange(_exchangeId, { conversationId } = {}) {
    return this.approveConversation(conversationId);
  }
}
