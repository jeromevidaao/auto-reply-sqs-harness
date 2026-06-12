import { BaseTool } from '../BaseTool.js';
import axios from 'axios';

/**
 * GoogleMapsTool
 *
 * Provides live (or mock) driving + walking distance and duration
 * from the rental property to guest-asked destinations (Old Port, downtown, etc.).
 *
 * Mirrors the exact behavior from the original auto-reply-grok-sqs Lambda:
 * - Uses Google Routes API v2 (computeRoutes) for DRIVE and WALK
 * - Returns imperial miles + rounded minutes
 * - Hardcoded origin for the 53 Pine St properties (all units share the address)
 * - Non-fatal on failure (returns fallback data so replies are never blocked)
 */
export class GoogleMapsTool extends BaseTool {
  constructor() {
    super({
      name: 'get_travel_times',
      description: 'Returns accurate driving and walking travel time + distance from the property address to a destination mentioned by the guest (e.g. Old Port, downtown, waterfront). Call this for any distance, "how far", walk, drive, Uber, or "how close" questions. Always report both modes when available.'
    });
  }

  async execute(input = {}, context = {}) {
    try {
      let guestMessage = '';
      let explicitDestination = '';

      if (typeof input === 'string') {
        guestMessage = input;
      } else if (input && typeof input === 'object') {
        guestMessage = input.guestMessage || input.message || '';
        explicitDestination = input.destination || '';
      }

      const destination = explicitDestination || this._extractDestination(guestMessage);
      if (!destination) {
        return { used: false, reason: 'no clear destination in message' };
      }

      const origin = this._resolveOrigin(context) || '53 Pine St, Portland, ME 04102';

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) {
        console.log('[GoogleMapsTool] No GOOGLE_MAPS_API_KEY present — returning mock data');
        return this._getMock(destination, origin);
      }

      const data = await this._fetchFromRoutesApi(origin, destination, apiKey);
      console.log(`[GoogleMapsTool] Live data for ${destination}: drive ${data.driving.duration}, walk ${data.walking.duration}`);

      return {
        destination,
        origin,
        driving: data.driving,
        walking: data.walking,
        source: 'google-routes-api-v2',
        used: true
      };
    } catch (err) {
      console.warn('[GoogleMapsTool] Live fetch failed (non-fatal):', err.message);
      // Fall back so we never break a guest reply
      const dest = (typeof input === 'string' ? input : input?.destination) || 'queried location';
      return {
        ...this._getMock(dest, '53 Pine St, Portland, ME 04102'),
        error: err.message,
        fallback: true
      };
    }
  }

  _extractDestination(message = '') {
    const m = message.toLowerCase();

    if (m.includes('old port')) return 'Old Port, Portland, ME';
    if (m.includes('downtown portland') || (m.includes('downtown') && m.includes('portland'))) return 'Downtown Portland, ME';
    if (m.includes('downtown')) return 'Downtown Portland, ME';
    if (m.includes('waterfront') || m.includes('marina') || m.includes('eastern prom')) return 'Portland Waterfront / Old Port, ME';
    if (m.includes('old portland') || m.includes('the port')) return 'Old Port, Portland, ME';

    // Generic "how close to X" or "walk to X"
    const generic = message.match(/(?:to|from|near|close to|how (?:far|close|long).*?(?:is|to|from))\s+([A-Za-z0-9\s,.'-]+?)(?:\?|\.|,|$)/i);
    if (generic && generic[1]) {
      let d = generic[1].trim();
      if (d.length > 3 && d.length < 60) {
        if (!/portland|me|maine/i.test(d)) d += ', Portland, ME';
        return d;
      }
    }

    return null;
  }

  _resolveOrigin(context = {}) {
    // All current properties are the three units at 53 Pine St.
    // If we ever have more listings we can extend via listingId here or in property files.
    if (context.listingId) {
      // Known West End cluster — same street, negligible difference for Old Port etc.
      return '53 Pine St, Portland, ME 04102';
    }
    if (context.propertyName && /pine|west end/i.test(context.propertyName)) {
      return '53 Pine St, Portland, ME 04102';
    }
    return null;
  }

  async _fetchFromRoutesApi(origin, destination, apiKey) {
    const call = async (travelMode) => {
      const body = {
        origin: { address: origin },
        destination: { address: destination },
        travelMode,
        languageCode: 'en-US',
        units: 'IMPERIAL'
      };

      if (travelMode === 'DRIVE') {
        body.routingPreference = 'TRAFFIC_AWARE_OPTIMAL';
        body.routeModifiers = {
          avoidTolls: false,
          avoidHighways: false,
          avoidFerries: false
        };
      }

      const resp = await axios.post(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
          },
          timeout: 15000
        }
      );

      const route = resp.data?.routes?.[0];
      if (!route) throw new Error('No route returned from Google');

      const meters = route.distanceMeters || 0;
      const durationStr = route.duration || '0s';
      const seconds = parseInt(durationStr.replace('s', ''), 10) || 0;

      const miles = (meters * 0.000621371).toFixed(1);
      const mins = Math.round(seconds / 60);

      return {
        distance: `${miles} miles`,
        duration: `${mins} minutes`
      };
    };

    const [driving, walking] = await Promise.all([
      call('DRIVE'),
      call('WALK')
    ]);

    return { driving, walking };
  }

  _getMock(destination, origin) {
    // Realistic fallback numbers for the 53 Pine St (West End) cluster to common Portland ME spots.
    // These are approximate; live data is always preferred.
    let driving, walking;

    const destLower = (destination || '').toLowerCase();

    if (destLower.includes('old port')) {
      driving = { distance: '1.7 miles', duration: '9 minutes' };
      walking = { distance: '1.7 miles', duration: '33 minutes' };
    } else if (destLower.includes('downtown')) {
      driving = { distance: '1.2 miles', duration: '7 minutes' };
      walking = { distance: '1.2 miles', duration: '23 minutes' };
    } else {
      driving = { distance: '1.5 miles', duration: '8 minutes' };
      walking = { distance: '1.5 miles', duration: '30 minutes' };
    }

    return {
      destination,
      origin,
      driving,
      walking,
      mock: true
    };
  }
}
