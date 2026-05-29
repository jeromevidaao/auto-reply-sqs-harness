import axios from 'axios';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

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

  const command = new GetParameterCommand({
    Name: '/hospitable/bearer-token',
    WithDecryption: true
  });

  const response = await ssm.send(command);
  _hospitableTokenCache = response.Parameter.Value;
  return _hospitableTokenCache;
}

export class HospitableClient {
  constructor() {
    this.baseUrl = 'https://public.api.hospitable.com/v2';
  }

  async getToken() {
    return _getHospitableToken();
  }

  /**
   * Check if a listing had any guests on a specific date (previous day logic).
   * Returns true if there was at least one reservation that overlapped with that date.
   */
  async hasGuestsOnDate(listingId, date) {
    const token = await this.getToken();

    // Check for reservations that were active on that date
    // A reservation overlaps if arrival_date <= date AND departure_date > date
    const response = await axios.get(`${this.baseUrl}/reservations`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      params: {
        'properties[]': listingId,
        'arrival_date[lte]': date,
        'departure_date[gt]': date,
        limit: 5
      },
      timeout: 8000
    });

    const reservations = response.data?.data || [];
    return reservations.length > 0;
  }

  /**
   * Get reservations for a specific listing on a given date range.
   * Useful for more advanced logic.
   */
  async getReservationsForDateRange(listingId, startDate, endDate) {
    const token = await this.getToken();

    const response = await axios.get(`${this.baseUrl}/reservations`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      params: {
        'properties[]': listingId,
        'arrival_date[gte]': startDate,
        'departure_date[lte]': endDate,
        limit: 20
      },
      timeout: 8000
    });

    return response.data?.data || [];
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
      timeout: 10000
    });

    return response.data?.data || [];
  }

  /**
   * Convenience: given a Hospitable reservation id, return its conversation_id
   * (the value you actually want for Airbnb message URLs).
   */
  async getConversationIdForReservation(reservationId) {
    const token = await this.getToken();

    const response = await axios.get(`${this.baseUrl}/reservations/${reservationId}`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      timeout: 8000
    });

    const res = response.data?.data;
    return res?.conversation_id || null;
  }

  /**
   * Send a message to a conversation (the main way to reply to a guest).
   * Uses the conversation_id (preferred over reservation/inquiry id for messaging).
   */
  async sendMessage(conversationId, body) {
    if (!conversationId) throw new Error('conversationId is required to send a message');
    if (!body || typeof body !== 'string') throw new Error('body must be a non-empty string');

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
        timeout: 15000
      }
    );

    return response.data?.data || response.data;
  }

  /**
   * Get full details for an inquiry (used for pre-approval detection).
   */
  async getInquiryDetails(inquiryId) {
    const token = await this.getToken();

    const response = await axios.get(`${this.baseUrl}/inquiries/${inquiryId}`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      timeout: 8000
    });

    return response.data?.data || null;
  }

  /**
   * Get recent messages for a conversation (inquiry or reservation).
   * Useful for pre-approval detection and recent host message checks.
   */
  async getConversationMessages(conversationId, limit = 10) {
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
      timeout: 8000
    });

    return response.data?.data || [];
  }
}
