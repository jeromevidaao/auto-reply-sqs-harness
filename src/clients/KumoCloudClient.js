import axios from 'axios';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({ region: 'us-east-1' });

const KUMO_BASE_URL = 'https://app-prod.kumocloud.com';
const KUMO_APP_VERSION = '3.0.9';

// Listing UUID → list of internal device IDs (the keys we have serials for)
const KUMO_DEVICES_BY_LISTING = {
  'c899481f-2e5b-402d-80c4-3167fd824d96': ['ff674e71-10cb-495c-9afb-959c434062aa', 'c221f8d8-cb87-4edf-9221-62f23759bb1a'], // Studio 1B / 53 Pine #1B
  '114663c5-0709-4eff-a868-fa9ebd6ed42d': ['a8a8d290-25ac-4f28-8c24-e2d6c3e7f3c5', '3f8d9e08-5e9b-49f7-a793-7d68bed5ed39', '86e24a6a-0988-4f91-a258-8704f70a22f1'], // Apt 2 (Sunny)
  '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd': ['18df3129-0790-490e-9545-cacd399f71b7', '30dc168d-698e-4218-b8d4-17d93cd15358', '7636c887-e946-4f55-9bd8-be9e0baa0bcd'], // Apt 3
};

// Internal deviceId (from above) → deviceSerial (used in Kumo v3 API paths + send-command)
const KUMO_DEVICE_SERIALS = {
  'ff674e71-10cb-495c-9afb-959c434062aa': '3934P008U100825F',
  'c221f8d8-cb87-4edf-9221-62f23759bb1a': '3Z34P0084100972F',
  'a8a8d290-25ac-4f28-8c24-e2d6c3e7f3c5': '1X34P008T180075F',
  '3f8d9e08-5e9b-49f7-a793-7d68bed5ed39': '1X34P008L180096F',
  '86e24a6a-0988-4f91-a258-8704f70a22f1': '3834P008B100294F',
  '18df3129-0790-490e-9545-cacd399f71b7': '1X34P008N180445F',
  '30dc168d-698e-4218-b8d4-17d93cd15358': '3834P008B100317F',
  '7636c887-e946-4f55-9bd8-be9e0baa0bcd': '1X34P008N180416F',
};

function cToF(c) {
  if (typeof c !== 'number') return null;
  return Math.round(c * 9 / 5 + 32);
}

function fToC(f) {
  if (typeof f !== 'number') return null;
  return Math.round((f - 32) * 5 / 9);
}

let _ssmCache = {};
async function _getSSMParam(name) {
  if (_ssmCache[name]) return _ssmCache[name];
  try {
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    _ssmCache[name] = Parameter.Value;
    return _ssmCache[name];
  } catch (err) {
    const e = new Error(`Failed to fetch SSM ${name}: ${err.message}`);
    e.name = 'KumoSSMError';
    throw e;
  }
}

async function _getKumoCreds() {
  const envEmail = process.env.KUMO_EMAIL || process.env.KUMO_CLOUD_EMAIL;
  const envPass = process.env.KUMO_PASSWORD || process.env.KUMO_CLOUD_PASSWORD;
  if (envEmail && envPass) {
    return { email: envEmail, password: envPass };
  }
  const [email, password] = await Promise.all([
    _getSSMParam('/kumocloud/email'),
    _getSSMParam('/kumocloud/password')
  ]);
  return { email, password };
}

let _accessToken = null;
let _tokenExpiresAt = 0;

async function kumoLogin(force = false) {
  if (!force && _accessToken && Date.now() < _tokenExpiresAt) {
    return _accessToken;
  }
  const { email, password } = await _getKumoCreds();
  const res = await axios({
    method: 'POST',
    url: `${KUMO_BASE_URL}/v3/login`,
    headers: { 'x-app-version': KUMO_APP_VERSION, 'Content-Type': 'application/json' },
    data: { username: email, password, appVersion: KUMO_APP_VERSION },
    timeout: 15000
  });
  _accessToken = res.data?.token?.access;
  if (!_accessToken) {
    throw new Error('Kumo login did not return access token');
  }
  _tokenExpiresAt = Date.now() + (14 * 60 * 1000); // 14 min safety (tokens ~20m)
  return _accessToken;
}

async function kumoGetDevice(serial, accessToken) {
  const res = await axios({
    method: 'GET',
    url: `${KUMO_BASE_URL}/v3/devices/${serial}`,
    headers: {
      'x-app-version': KUMO_APP_VERSION,
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    },
    timeout: 15000
  });
  return res.data;
}

async function kumoSetDevice(serial, mode, tempF, accessToken) {
  const tempC = fToC(tempF);
  const payload = {
    deviceSerial: serial,
    commands: {
      power: 1,
      operationMode: mode, // 'cool' | 'heat' | 'auto' | 'autoHeat' etc. as supported by the unit
      spCool: tempC,
      spHeat: tempC,
      fanSpeed: 'auto',
      airDirection: 'swing'
    }
  };
  await axios({
    method: 'POST',
    url: `${KUMO_BASE_URL}/v3/devices/send-command`,
    headers: {
      'x-app-version': KUMO_APP_VERSION,
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    data: payload,
    timeout: 15000
  });
}

/**
 * KumoCloudClient
 * Live status + control for the KumoCloud (Mitsubishi) heat pumps.
 * Used by HeatPumpTool to investigate (and auto-remediate) mixed-mode / wrong-season issues
 * that cause "AC on but no air" or no heat.
 */
export class KumoCloudClient {
  constructor(options = {}) {
    this.mockDataByListing = options.mockDataByListing || null; // { listingId: {units: [...] } }
    this._lastStatusCache = {}; // simple per-run cache
  }

  /**
   * For tests/eval: inject a fake status that will be returned instead of calling real API.
   */
  setMockStatus(listingId, status) {
    if (!this.mockDataByListing) this.mockDataByListing = {};
    this.mockDataByListing[listingId] = status;
  }

  async getStatusForListing(listingId) {
    if (this.mockDataByListing && this.mockDataByListing[listingId]) {
      const mock = this.mockDataByListing[listingId];
      console.log(`[KumoCloudClient] Using MOCK status for ${listingId}`);
      return { listingId, ...mock, _mock: true };
    }

    const deviceIds = KUMO_DEVICES_BY_LISTING[listingId];
    if (!deviceIds || deviceIds.length === 0) {
      return { listingId, units: [], error: 'No Kumo device mapping for this listing' };
    }

    try {
      const token = await kumoLogin();
      const units = [];

      for (const deviceId of deviceIds) {
        const serial = KUMO_DEVICE_SERIALS[deviceId];
        if (!serial) {
          units.push({ deviceId, error: 'no serial mapping' });
          continue;
        }
        try {
          const raw = await kumoGetDevice(serial, token);
          const roomC = typeof raw.roomTemp === 'number' ? raw.roomTemp : null;
          const spCoolC = typeof raw.spCool === 'number' ? raw.spCool : null;
          const spHeatC = typeof raw.spHeat === 'number' ? raw.spHeat : null;

          units.push({
            deviceId,
            serial,
            power: raw.power,
            operationMode: raw.operationMode,
            roomTempC: roomC,
            roomTempF: cToF(roomC),
            spCoolC,
            spCoolF: cToF(spCoolC),
            spHeatC,
            spHeatF: cToF(spHeatC),
            fanSpeed: raw.fanSpeed,
            airDirection: raw.airDirection,
            connected: raw.connected,
            lastStatusChangeAt: raw.lastStatusChangeAt,
            // include a couple raw fields guests care about
            humidity: raw.humidity
          });
        } catch (perErr) {
          units.push({ deviceId, serial, error: perErr.message || String(perErr) });
        }
      }

      const modes = units.map(u => u.operationMode).filter(Boolean);
      const uniqueModes = [...new Set(modes)];
      const roomTempsF = units.map(u => u.roomTempF).filter(t => typeof t === 'number');
      const avgRoomF = roomTempsF.length
        ? Math.round(roomTempsF.reduce((a, b) => a + b, 0) / roomTempsF.length)
        : null;

      return {
        listingId,
        unitCount: units.length,
        units,
        summary: {
          modes: uniqueModes,
          mixedModes: uniqueModes.length > 1,
          avgRoomTempF: avgRoomF,
          anyDisconnected: units.some(u => u.connected === false),
          allSameMode: uniqueModes.length === 1
        },
        fetchedAt: new Date().toISOString()
      };
    } catch (err) {
      // If creds missing or login fails, surface gracefully (don't crash the whole reply)
      const msg = err.message || String(err);
      console.warn('[KumoCloudClient] getStatusForListing failed:', msg);
      return {
        listingId,
        units: [],
        error: msg,
        summary: { mixedModes: false, error: true }
      };
    }
  }

  async setAllUnits(listingId, mode, tempF) {
    const deviceIds = KUMO_DEVICES_BY_LISTING[listingId];
    if (!deviceIds || deviceIds.length === 0) {
      return { listingId, success: false, error: 'no mapping for listing', unitsSet: 0 };
    }

    try {
      const token = await kumoLogin();
      const results = [];
      let ok = 0;

      for (const deviceId of deviceIds) {
        const serial = KUMO_DEVICE_SERIALS[deviceId];
        if (!serial) {
          results.push({ deviceId, success: false, error: 'no serial' });
          continue;
        }
        try {
          await kumoSetDevice(serial, mode, tempF, token);
          results.push({ deviceId, serial, success: true });
          ok++;
        } catch (setErr) {
          results.push({ deviceId, serial, success: false, error: setErr.message });
        }
      }

      console.log(`[KumoCloudClient] setAllUnits ${listingId} → mode=${mode} tempF=${tempF} : ${ok}/${deviceIds.length} ok`);

      return {
        listingId,
        success: ok > 0,
        mode,
        tempF,
        unitsSet: ok,
        total: deviceIds.length,
        results
      };
    } catch (err) {
      return { listingId, success: false, error: err.message, unitsSet: 0 };
    }
  }

  /**
   * High-level helper used by the tool: if mixed or wrong mode for the complaint, fix it.
   * Returns {fixed, before, setResult, recommendedMode, recommendedTempF}
   */
  async ensureConsistentForComplaint(listingId, guestMessage = '') {
    const lower = (guestMessage || '').toLowerCase();
    const wantsHeat = /\b(heat|heating|warm|freezing|cold|chilly|too cold)\b/.test(lower);
    const wantsCool = /\b(ac|cool|cooling|air|hot|warm|no air|not blowing|boiling|stuffy)\b/.test(lower);

    // Default logic: AC complaints → cool or auto at 65; heating complaints → heat at 72
    let mode = 'auto';
    let tempF = 65;
    if (wantsHeat && !wantsCool) {
      mode = 'heat';
      tempF = 72;
    } else if (wantsCool) {
      mode = 'auto'; // match real-world fix for the "remotes on, no air" case (one head was heat); auto at 65 will cool when outdoor is hot
      tempF = 65;
    }
    // If guest mentioned "auto" or we want to match the real fix in the Kathryn case, prefer auto for cooling issues
    if (wantsCool && /auto/.test(lower)) {
      mode = 'auto';
    }

    const before = await this.getStatusForListing(listingId);
    const summary = before.summary || {};

    const needsFix = summary.mixedModes ||
      (summary.modes && summary.modes.length > 0 && !summary.modes.includes(mode) && !summary.modes.includes('auto'));

    if (!needsFix) {
      return {
        fixed: false,
        reason: summary.mixedModes ? 'mixed but we decided not to override' : 'already consistent or no data',
        before,
        recommendedMode: mode,
        recommendedTempF: tempF
      };
    }

    const setResult = await this.setAllUnits(listingId, mode, tempF);
    // Re-fetch briefly for "after" view (best effort)
    let after = null;
    try { after = await this.getStatusForListing(listingId); } catch (_) {}

    return {
      fixed: !!setResult.success,
      before,
      setResult,
      after,
      recommendedMode: mode,
      recommendedTempF: tempF,
      reason: 'mixed modes or wrong season mode for complaint'
    };
  }
}

export default KumoCloudClient;
