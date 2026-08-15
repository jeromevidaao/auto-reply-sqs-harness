/**
 * HomeExchange inbox client for the isolated HE auto-reply use case.
 * Never used by the Airbnb / Hospitable send path.
 *
 * Auth: SSM /homeexchange/bearer-token (same token as cleaningbutton-api HE chat).
 */
import axios from 'axios';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

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
  const response = await ssm.send(
    new GetParameterCommand({ Name: HE_TOKEN_SSM, WithDecryption: true })
  );
  _tokenCache = response.Parameter.Value;
  return _tokenCache;
}

export function alreadySentEquivalent(messages, proposedResponse) {
  const proposed = String(proposedResponse || '').trim().toLowerCase();
  if (!proposed) return false;
  const preview = proposed.slice(0, 80);
  const list = Array.isArray(messages) ? messages : [];
  const proposedIsFeeAsk = /cleaning fee/.test(proposed) && /after your stay/.test(proposed);
  return list.some((m) => {
    const text = String(m.content || m.body || m.text || '').trim().toLowerCase();
    if (!text) return false;
    if (text === proposed) return true;
    if (text.includes(preview) || proposed.includes(text.slice(0, 80))) return true;
    // Only the first-message fee-after-stay ask is equivalent to another fee ask.
    // A later "fee is fine + extra dates" reply must still send.
    if (proposedIsFeeAsk && /cleaning fee/.test(text) && /after your stay/.test(text)) {
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
  constructor({ token } = {}) {
    this._injectedToken = token || null;
  }

  async getToken() {
    if (this._injectedToken) return this._injectedToken;
    return _loadToken();
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
    const response = await axios.get(`${HE_API_BASE}/v3/messages`, {
      headers: this._headers(token),
      params: { conversation_id: conversationId },
      timeout: 20000,
    });
    return (
      response.data?.data?.messages ||
      response.data?.messages ||
      []
    );
  }

  async sendMessage(conversationId, content) {
    if (!conversationId) throw new Error('conversationId is required to send a HomeExchange message');
    if (!content || typeof content !== 'string') throw new Error('content must be a non-empty string');
    const token = await this.getToken();
    const response = await axios.post(
      `${HE_API_BASE}/v1/messages`,
      { content, conversation: this._conversationField(conversationId) },
      { headers: this._headers(token), timeout: 20000 }
    );
    return response.data || { ok: true };
  }

  async getConversation(conversationId) {
    if (!conversationId) throw new Error('conversationId is required');
    const token = await this.getToken();
    const response = await axios.get(
      `${HE_API_BASE}/v3/conversations/me/${encodeURIComponent(conversationId)}`,
      { headers: this._headers(token), timeout: 20000 }
    );
    const data = response.data?.data || response.data || {};
    return data.conversation || data;
  }

  /**
   * Home calendar as [start_on, end_on) ranges.
   * Live types: NON_RECIPROCAL (open for GP stays), RESERVED (blocked / booked).
   * Nights not covered by any range are closed (owner long-block).
   */
  async getHomeCalendar(homeId) {
    if (!homeId) throw new Error('homeId is required');
    const token = await this.getToken();
    const response = await axios.get(
      `${HE_API_BASE}/v1/homes/${encodeURIComponent(homeId)}/calendar`,
      { headers: this._headers(token), timeout: 20000 }
    );
    const payload = response.data;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    return [];
  }

  /**
   * Host pre-approve. Live route: PATCH /v1/conversations/{id} { accepted: true }
   * (PATCH /v1/exchanges/{id}/approve is a 400 PHP offset error.)
   * Guest then has ~4 days to finalize.
   */
  async approveConversation(conversationId) {
    if (!conversationId) throw new Error('conversationId is required');
    const token = await this.getToken();
    const response = await axios.patch(
      `${HE_API_BASE}/v1/conversations/${encodeURIComponent(conversationId)}`,
      { accepted: true },
      { headers: this._headers(token), timeout: 20000 }
    );
    return response.data || { ok: true };
  }

  /** @deprecated use approveConversation */
  async approveExchange(_exchangeId, { conversationId } = {}) {
    return this.approveConversation(conversationId);
  }
}
