import axios from 'axios';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({ region: 'us-east-1' });

let _hospitableTokenCache = null;

async function _getHospitableToken() {
  if (_hospitableTokenCache) return _hospitableTokenCache;

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
