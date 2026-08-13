import axios from 'axios';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  HOSPITABLE_READ_MAX_ATTEMPTS,
  HOSPITABLE_READ_TIMEOUT_MS,
  HOSPITABLE_SEND_MAX_ATTEMPTS,
  HOSPITABLE_SEND_TIMEOUT_MS,
  hostAlreadySentEquivalent,
  withExponentialBackoff,
} from '../utils/httpRetry.js';

const ssm = new SSMClient({ region: 'us-east-1' });

let _hospitableTokenCache = null;

/**
 * Get Hospitable bearer token.
 * Priority:
 *   1. HOSPITABLE_BEARER_TOKEN env var (for local dev / manual testing)
 *   2. SSM Parameter Store /hospitable/bearer-token (production / Lambda)
 */
async function _getHospitableToken() {
  if (_hospitableTokenCache) return _hospitableTokenCache;

  // Local dev convenience (matches the comment in .env.example)
  const envToken = process.env.HOSPITABLE_BEARER_TOKEN;
  if (envToken) {
    _hospitableTokenCache = envToken;
    return _hospitableTokenCache;
  }

  // Retry SSM token fetch (can be occasionally flaky)
  const maxAttempts = 3;
  const delays = [2000, 4000, 8000];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const command = new GetParameterCommand({
        Name: '/hospitable/bearer-token',
        WithDecryption: true
      });
      const response = await ssm.send(command);
      _hospitableTokenCache = response.Parameter.Value;
      return _hospitableTokenCache;
    } catch (err) {
      if (attempt === maxAttempts) {
        const criticalErr = new Error(`CRITICAL: Failed to fetch Hospitable token from SSM after ${maxAttempts} attempts. ${err.message}`);
        criticalErr.name = 'CriticalHospitableError';
        criticalErr.originalError = err;
        throw criticalErr;
      }
      const delay = delays[attempt - 1];
      console.warn(`[HospitableClient] SSM token fetch failed (attempt ${attempt}). Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export class HospitableClient {
  constructor() {
    this.baseUrl = 'https://public.api.hospitable.com/v2';
  }

  async getToken() {
    return _getHospitableToken();
  }

  /**
   * Retry wrapper for Hospitable reads / non-send calls.
   * Exponential backoff; only transient errors (5xx, 429, network/timeout).
   */
  async _withRetry(operation, fn, extras = {}) {
    return withExponentialBackoff(fn, {
      operation,
      kind: extras.kind || 'read',
      maxAttempts: extras.maxAttempts || HOSPITABLE_READ_MAX_ATTEMPTS,
      recover: extras.recover,
    });
  }

  /**
   * POST a guest message with rate-limit-aware backoff.
   * After timeout/5xx, GET the thread — Hospitable may have accepted the POST
   * even when the client timed out (Julie 2026-08-13 incident).
   */
  async _sendWithConfirm(operation, body, postFn, fetchRecentFn) {
    const recover = async (err) => {
      if (typeof fetchRecentFn !== 'function') return false;
      try {
        const recent = await fetchRecentFn();
        if (hostAlreadySentEquivalent(recent, body)) {
          console.warn(
            `[HospitableClient] ${operation} failed (${err.message}) but the draft is already on the thread — treating as delivered`
          );
          return { alreadyDelivered: true, recoveredFrom: err.message, data: recent };
        }
      } catch (fetchErr) {
        console.warn(
          `[HospitableClient] post-failure thread check failed for ${operation}:`,
          fetchErr?.message || fetchErr
        );
      }
      return false;
    };

    return withExponentialBackoff(postFn, {
      operation,
      kind: 'send',
      maxAttempts: HOSPITABLE_SEND_MAX_ATTEMPTS,
      recover,
    });
  }

  async _authHeaders() {
    const token = await this.getToken();
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Check if a listing had any guests on a specific date (previous day logic).
   * Returns true if there was at least one reservation that overlapped with that date.
   */
  async hasGuestsOnDate(listingId, date) {
    return this._withRetry('hasGuestsOnDate', async () => {
      const response = await axios.get(`${this.baseUrl}/reservations`, {
        headers: await this._authHeaders(),
        params: {
          'properties[]': listingId,
          'arrival_date[lte]': date,
          'departure_date[gt]': date,
          limit: 5
        },
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      const reservations = response.data?.data || [];
      return reservations.length > 0;
    });
  }

  /**
   * Get reservations for a specific listing on a given date range.
   * Useful for more advanced logic.
   */
  async getReservationsForDateRange(listingId, startDate, endDate) {
    return this._withRetry('getReservationsForDateRange', async () => {
      const response = await axios.get(`${this.baseUrl}/reservations`, {
        headers: await this._authHeaders(),
        params: {
          'properties[]': listingId,
          'arrival_date[gte]': startDate,
          'departure_date[lte]': endDate,
          limit: 20
        },
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      return response.data?.data || [];
    });
  }

  /**
   * Fetch reservations from Hospitable (the endpoint documented at
   * https://developer.hospitable.com/docs/public-api-docs/ih7nc1ovefrcs-get-reservations).
   *
   * The API requires at least one 'properties[]' filter in almost all cases.
   *
   * @param {Object} options
   * @param {string|string[]} options.properties - Listing UUID(s) (required by the API)
   * @param {number} [options.limit=20]
   * @param {string} [options.status] - e.g. 'accepted', 'confirmed'
   * @param {string} [options.sort='-arrival_date']
   * @returns {Promise<Array>} reservation objects (each includes conversation_id)
   */
  async getReservations(options = {}) {
    return this._withRetry('getReservations', async () => {
      const token = await this.getToken();
      const {
        properties,
        limit = 20,
        status,
        sort = '-arrival_date',
        ...otherParams
      } = options;

      const params = {
        limit,
        sort,
        ...otherParams
      };

      if (properties) {
        // Support single string or array
        const props = Array.isArray(properties) ? properties : [properties];
        props.forEach(p => {
          // Axios will repeat the key for arrays
        });
        params['properties[]'] = props;
      }

      if (status) params.status = status;

      const response = await axios.get(`${this.baseUrl}/reservations`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        params,
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      return response.data?.data || [];
    });
  }

  /**
   * Convenience: given a Hospitable reservation id, return its conversation_id
   * (the value you actually want for Airbnb message URLs).
   */
  async getConversationIdForReservation(reservationId) {
    return this._withRetry('getConversationIdForReservation', async () => {
      const token = await this.getToken();

      const response = await axios.get(`${this.baseUrl}/reservations/${reservationId}`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      const res = response.data?.data;
      return res?.conversation_id || null;
    });
  }

  /**
   * Fetch full reservation details by ID.
   * Includes check_in, check_out, guests.pet_count, properties, guest info etc.
   * Used to reliably populate hasPets/petCount/checkIn for NEW_RESERVATION_WELCOME pet logic and timing.
   */
  async getReservation(reservationId) {
    if (!reservationId) throw new Error('reservationId is required');
    return this._withRetry('getReservation', async () => {
      const token = await this.getToken();

      const response = await axios.get(`${this.baseUrl}/reservations/${reservationId}`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        params: {
          include: 'properties,guest'
        },
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      return response.data?.data || response.data;
    });
  }

  /**
   * Send a message to a reservation (the method that the original working
   * auto-reply-sqs Lambda used successfully).
   */
  async sendMessageToReservation(reservationId, body) {
    if (!reservationId) throw new Error('reservationId is required to send a message');
    if (!body || typeof body !== 'string') throw new Error('body must be a non-empty string');

    return this._sendWithConfirm(
      'sendMessageToReservation',
      body,
      async () => {
        const token = await this.getToken();
        const response = await axios.post(
          `${this.baseUrl}/reservations/${reservationId}/messages`,
          { body },
          {
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${token}`
            },
            timeout: HOSPITABLE_SEND_TIMEOUT_MS
          }
        );
        return response.data?.data || response.data;
      },
      () => this.getReservationMessages(reservationId, 8)
    );
  }

  /**
   * Send a message to a conversation.
   * Note: The original production system that was sending successfully used
   * sendMessageToReservation (via reservationUuid) instead.
   */
  async sendMessage(conversationId, body) {
    if (!conversationId) throw new Error('conversationId is required to send a message');
    if (!body || typeof body !== 'string') throw new Error('body must be a non-empty string');

    return this._sendWithConfirm(
      'sendMessage',
      body,
      async () => {
        const token = await this.getToken();
        const response = await axios.post(
          `${this.baseUrl}/conversations/${conversationId}/messages`,
          { body },
          {
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${token}`
            },
            timeout: HOSPITABLE_SEND_TIMEOUT_MS
          }
        );
        return response.data?.data || response.data;
      },
      () => this.getConversationMessages(conversationId, 8)
    );
  }

  /**
   * Send a message for an inquiry (pre-booking / no reservation_id case).
   * The old monolithic system had a dedicated sendInquiryMessage path for webhooks
   * where reservation_id is null but conversation_id (or equivalent) is present.
   * We try the /inquiries/{id}/messages endpoint (symmetric to getInquiryDetails).
   * If this (or the conversation fallback) 404s for the ID provided in the webhook,
   * the handler will escalate the generated reply instead of hard-failing the Lambda.
   */
  async sendMessageToInquiry(inquiryId, body) {
    if (!inquiryId) throw new Error('inquiryId is required to send a message');
    if (!body || typeof body !== 'string') throw new Error('body must be a non-empty string');

    return this._sendWithConfirm(
      'sendMessageToInquiry',
      body,
      async () => {
        const token = await this.getToken();
        const response = await axios.post(
          `${this.baseUrl}/inquiries/${inquiryId}/messages`,
          { body },
          {
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${token}`
            },
            timeout: HOSPITABLE_SEND_TIMEOUT_MS
          }
        );
        return response.data?.data || response.data;
      },
      () => this.getInquiryMessages(inquiryId, 8)
    );
  }

  /**
   * Get full details for an inquiry (used for pre-approval detection).
   */
  async getInquiryDetails(inquiryId) {
    return this._withRetry('getInquiryDetails', async () => {
      const token = await this.getToken();

      const response = await axios.get(`${this.baseUrl}/inquiries/${inquiryId}`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        params: {
          // Request richer data (properties, guest, etc.) to better match the documented
          // response shape that includes guests.pet_count (see Hospitable Get Inquiry by UUID docs).
          // This helps when the webhook is minimal for pre-booking inquiries.
          include: 'properties,guest'
        },
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      return response.data?.data || null;
    });
  }

  /**
   * Get messages for a reservation thread.
   *
   * Official API: GET /v2/reservations/{reservationUuid}/messages
   * @see https://developer.hospitable.com/docs/public-api-docs/n6jr1z9iwhm8w-get-reservation-messages
   * Required scope: message:read
   *
   * Use this (not GET /conversations/{id}/messages) for all booked stays — the conversation
   * endpoint returns 404 on reservation threads (Rene incident).
   */
  async getReservationMessages(reservationId, limit = 10) {
    if (!reservationId) throw new Error('reservationId is required for getReservationMessages');

    return this._withRetry('getReservationMessages', async () => {
      const token = await this.getToken();

      const response = await axios.get(`${this.baseUrl}/reservations/${reservationId}/messages`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        params: {
          limit
        },
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      return response.data?.data || [];
    });
  }

  /**
   * Get messages for an inquiry thread (pre-booking / no reservation_id).
   *
   * Hospitable exposes inquiry messages on GET /v2/inquiries/{inquiryUuid}?include=messages.
   * POST /inquiries/{id}/messages is send-only (GET returns 405). Webhook inquiry events use
   * the inquiry UUID as conversation_id; GET /conversations/{id}/messages 404s (Jun 2026 incident).
   */
  async getInquiryMessages(inquiryId, limit = 10) {
    if (!inquiryId) throw new Error('inquiryId is required for getInquiryMessages');

    return this._withRetry('getInquiryMessages', async () => {
      const token = await this.getToken();

      const response = await axios.get(`${this.baseUrl}/inquiries/${inquiryId}`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        params: {
          include: 'messages'
        },
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      const messages = response.data?.data?.messages || [];
      return Array.isArray(messages) ? messages.slice(0, limit) : [];
    });
  }

  /**
   * Get recent messages for a conversation UUID (legacy / non-inquiry threads).
   * For reservations use getReservationMessages; for inquiries use getInquiryMessages —
   * this endpoint 404s on both reservation and inquiry threads in practice.
   */
  async getConversationMessages(conversationId, limit = 10) {
    return this._withRetry('getConversationMessages', async () => {
      const token = await this.getToken();

      const response = await axios.get(`${this.baseUrl}/conversations/${conversationId}/messages`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        params: {
          limit
        },
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      return response.data?.data || [];
    });
  }

  /**
   * Fetch thread messages using the correct Hospitable endpoint for the context.
   * Reservations → GET /reservations/{id}/messages
   * Inquiries (no reservation) → GET /inquiries/{id}?include=messages (webhook conversation_id is inquiry UUID)
   */
  async getThreadMessages({ reservationId, conversationId, isInquiry } = {}, limit = 10) {
    if (reservationId) {
      return this.getReservationMessages(reservationId, limit);
    }
    if (conversationId) {
      if (isInquiry !== false) {
        return this.getInquiryMessages(conversationId, limit);
      }
      return this.getConversationMessages(conversationId, limit);
    }
    throw new Error('reservationId or conversationId is required for getThreadMessages');
  }

  /**
   * List reservations for a property over a date window (check-in query window).
   * Caller should expand the window and filter client-side for night overlap —
   * the API date filter is check-in based by default and can miss long stays.
   *
   * Endpoint: GET /reservations?properties[]=...&start_date=...&end_date=...
   */
  async getPropertyReservations(propertyId, startDate, endDate, { perPage = 100 } = {}) {
    if (!propertyId) throw new Error('propertyId is required for getPropertyReservations');
    if (!startDate || !endDate) throw new Error('startDate and endDate are required for getPropertyReservations');

    return this._withRetry('getPropertyReservations', async () => {
      const token = await this.getToken();
      const all = [];
      let page = 1;
      let lastPage = 1;

      do {
        const response = await axios.get(`${this.baseUrl}/reservations`, {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
          params: {
            'properties[]': propertyId,
            start_date: startDate,
            end_date: endDate,
            include: 'guest',
            per_page: perPage,
            page,
          },
          timeout: HOSPITABLE_READ_TIMEOUT_MS,
        });
        const batch = response.data?.data || [];
        all.push(...batch);
        lastPage = response.data?.meta?.last_page || 1;
        page += 1;
      } while (page <= lastPage && page <= 10);

      return all;
    });
  }

  /**
   * Fetch the calendar (availability + pricing) for a specific property/listing.
   * Used to accurately answer stay extension requests (full day date changes)
   * without fabricating availability information.
   *
   * Endpoint: GET /properties/{uuid}/calendar?start_date=...&end_date=...
   * Response entries typically include { date, available, price, min_stay, ... }
   */
  async getPropertyCalendar(propertyId, startDate, endDate) {
    if (!propertyId) throw new Error('propertyId is required for getPropertyCalendar');
    if (!startDate || !endDate) throw new Error('startDate and endDate are required for getPropertyCalendar');

    return this._withRetry('getPropertyCalendar', async () => {
      const token = await this.getToken();

      const response = await axios.get(`${this.baseUrl}/properties/${propertyId}/calendar`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        params: {
          start_date: startDate,
          end_date: endDate
        },
        timeout: HOSPITABLE_READ_TIMEOUT_MS
      });

      // Normalize to a flat day-entry array. Live Hospitable v2 shape is:
      //   { data: { listing_id, start_date, end_date, days: [ { date, status: { available }, ... } ] } }
      // Older / alternate shapes may be { data: [...] } or a bare array.
      const payload = response.data;
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.data?.days)) return payload.data.days;
      if (Array.isArray(payload?.days)) return payload.days;
      if (Array.isArray(payload?.data)) return payload.data;
      return [];
    });
  }
}
