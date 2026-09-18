/**
 * Host / operational contact details — never hardcode personal phones or emails in source.
 *
 * Load order:
 * 1. process.env.HOST_CONTACTS_JSON (full JSON)
 * 2. Individual env vars (HOST_JEROME_PHONE, …)
 * 3. SSM SecureString /host/contacts-json
 * 4. Test-only synthetic defaults when ALLOW_HOST_CONTACT_TEST_DEFAULTS=1
 *
 * Placeholders substituted into prompts:
 *   {{HOST_JEROME_PHONE}} {{HOST_RUBY_PHONE}} {{HOST_RICHARD_PHONE}}
 *   {{HOST_RICHARD_PHONE_PRIMARY}} {{HOST_RICHARD_PHONE_ALT}}
 *   {{WIFI_SSID}} {{WIFI_PASSWORD}} {{OWNER_EMAIL}} {{APT2_STREET_LOCKBOX_CODE}}
 *   {{BACKUP_DOOR_CODE}} {{APT3_LOCKBOX_CODE}}
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const SSM_PATH = process.env.HOST_CONTACTS_SSM || '/host/contacts-json';
const REGION = process.env.AWS_REGION || 'us-east-1';

/** Synthetic values for unit tests only — not production. */
export const TEST_HOST_CONTACTS = Object.freeze({
  jeromePhoneDisplay: '555-010-0001',
  rubyPhoneDisplay: '555-010-0002',
  richardPhoneDisplay: '555-010-0003',
  richardPhonePrimary: '(555) 010-0004',
  richardPhoneAlt: '(555) 010-0003',
  jeromePhoneE164: '+15550100001',
  rubyPhoneE164: '+15550100002',
  wifiSsid: 'Pineland',
  wifiPassword: 'lobsterbake',
  ownerEmail: 'owner-test@example.com',
  urgentAccessE164: '+15550100001,+15550100002',
  apt2StreetLockboxCode: '0000',
  backupDoorCode: '9999',
  apt3LockboxCode: '8888',
  propertyManagerName: 'Richard',
});

let _cache = null;
let _loadPromise = null;

function fromEnvIndividuals() {
  const j = process.env.HOST_JEROME_PHONE;
  const r = process.env.HOST_RUBY_PHONE;
  const rp = process.env.HOST_RICHARD_PHONE || process.env.HOST_RICHARD_PHONE_PRIMARY;
  if (!j && !r && !rp) return null;
  return {
    jeromePhoneDisplay: j || '',
    rubyPhoneDisplay: r || '',
    richardPhoneDisplay: process.env.HOST_RICHARD_PHONE || process.env.HOST_RICHARD_PHONE_ALT || '',
    richardPhonePrimary: process.env.HOST_RICHARD_PHONE_PRIMARY || rp || '',
    richardPhoneAlt: process.env.HOST_RICHARD_PHONE_ALT || process.env.HOST_RICHARD_PHONE || '',
    jeromePhoneE164: process.env.HOST_JEROME_PHONE_E164 || '',
    rubyPhoneE164: process.env.HOST_RUBY_PHONE_E164 || '',
    wifiSsid: process.env.WIFI_SSID || '',
    wifiPassword: process.env.WIFI_PASSWORD || '',
    ownerEmail: process.env.OWNER_EMAIL || process.env.HOST_OWNER_EMAIL || '',
    urgentAccessE164:
      process.env.URGENT_ACCESS_PHONE_NUMBER ||
      process.env.HOST_URGENT_ACCESS_E164 ||
      '',
    apt2StreetLockboxCode: process.env.APT2_STREET_LOCKBOX_CODE || '',
    backupDoorCode: process.env.BACKUP_DOOR_CODE || '',
    apt3LockboxCode: process.env.APT3_LOCKBOX_CODE || '',
    propertyManagerName: process.env.HOST_PM_NAME || 'Richard',
  };
}

function normalize(raw = {}) {
  return {
    jeromePhoneDisplay: String(raw.jeromePhoneDisplay || raw.jerome_phone || '').trim(),
    rubyPhoneDisplay: String(raw.rubyPhoneDisplay || raw.ruby_phone || '').trim(),
    richardPhoneDisplay: String(raw.richardPhoneDisplay || raw.richard_phone || '').trim(),
    richardPhonePrimary: String(
      raw.richardPhonePrimary || raw.richard_phone_primary || raw.richardPhoneDisplay || ''
    ).trim(),
    richardPhoneAlt: String(
      raw.richardPhoneAlt || raw.richard_phone_alt || raw.richardPhoneDisplay || ''
    ).trim(),
    jeromePhoneE164: String(raw.jeromePhoneE164 || raw.jerome_phone_e164 || '').trim(),
    rubyPhoneE164: String(raw.rubyPhoneE164 || raw.ruby_phone_e164 || '').trim(),
    wifiSsid: String(raw.wifiSsid || raw.wifi_ssid || '').trim(),
    wifiPassword: String(raw.wifiPassword || raw.wifi_password || '').trim(),
    ownerEmail: String(raw.ownerEmail || raw.owner_email || '').trim(),
    urgentAccessE164: String(
      raw.urgentAccessE164 || raw.urgent_access_e164 || raw.urgentAccessPhones || ''
    ).trim(),
    apt2StreetLockboxCode: String(
      raw.apt2StreetLockboxCode || raw.apt2_street_lockbox_code || ''
    ).trim(),
    backupDoorCode: String(
      raw.backupDoorCode || raw.backup_door_code || raw.backupCode || ''
    ).trim(),
    apt3LockboxCode: String(
      raw.apt3LockboxCode || raw.apt3_lockbox_code || ''
    ).trim(),
    propertyManagerName: String(raw.propertyManagerName || raw.pm_name || 'Richard').trim(),
  };
}

/**
 * Load host contacts (cached). Safe to call repeatedly.
 * @returns {Promise<ReturnType<typeof normalize>>}
 */
export async function loadHostContacts() {
  if (_cache) return _cache;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    if (process.env.HOST_CONTACTS_JSON) {
      try {
        _cache = normalize(JSON.parse(process.env.HOST_CONTACTS_JSON));
        return _cache;
      } catch (err) {
        console.warn('[hostContacts] HOST_CONTACTS_JSON parse failed:', err.message);
      }
    }

    const fromEnv = fromEnvIndividuals();
    if (fromEnv && (fromEnv.jeromePhoneDisplay || fromEnv.richardPhonePrimary)) {
      _cache = normalize(fromEnv);
      return _cache;
    }

    try {
      const ssm = new SSMClient({ region: REGION });
      const res = await ssm.send(
        new GetParameterCommand({ Name: SSM_PATH, WithDecryption: true })
      );
      const value = res.Parameter?.Value;
      if (value) {
        _cache = normalize(JSON.parse(value));
        // Mirror into env for any code paths that only read env (urgent SMS, etc.)
        if (_cache.urgentAccessE164 && !process.env.URGENT_ACCESS_PHONE_NUMBER) {
          process.env.URGENT_ACCESS_PHONE_NUMBER = _cache.urgentAccessE164;
        }
        return _cache;
      }
    } catch (err) {
      console.warn(`[hostContacts] SSM ${SSM_PATH} unavailable:`, err.message);
    }

    if (process.env.ALLOW_HOST_CONTACT_TEST_DEFAULTS === '1') {
      console.warn('[hostContacts] Using TEST_HOST_CONTACTS (ALLOW_HOST_CONTACT_TEST_DEFAULTS=1)');
      _cache = { ...TEST_HOST_CONTACTS };
      return _cache;
    }

    // Empty shell — callers must tolerate missing values (or fail closed for lockout scripts).
    _cache = normalize({});
    console.warn(
      '[hostContacts] No contacts loaded. Set SSM /host/contacts-json or HOST_CONTACTS_JSON.'
    );
    return _cache;
  })();

  try {
    return await _loadPromise;
  } finally {
    _loadPromise = null;
  }
}

/** Synchronous access after loadHostContacts() (or setHostContactsForTests). */
export function getHostContactsSync() {
  return _cache || normalize({});
}

/** Tests / eval inject fixtures without SSM. */
export function setHostContactsForTests(contacts) {
  _cache = normalize(contacts || TEST_HOST_CONTACTS);
  if (_cache.urgentAccessE164) {
    process.env.URGENT_ACCESS_PHONE_NUMBER = _cache.urgentAccessE164;
  }
}

export function clearHostContactsCache() {
  _cache = null;
  _loadPromise = null;
}

/**
 * Replace {{PLACEHOLDER}} tokens in prompt markdown.
 */
export function applyHostContactPlaceholders(text, contacts = null) {
  const c = contacts || getHostContactsSync();
  const map = {
    '{{HOST_JEROME_PHONE}}': c.jeromePhoneDisplay,
    '{{HOST_RUBY_PHONE}}': c.rubyPhoneDisplay,
    '{{HOST_RICHARD_PHONE}}': c.richardPhoneDisplay || c.richardPhoneAlt,
    '{{HOST_RICHARD_PHONE_PRIMARY}}': c.richardPhonePrimary,
    '{{HOST_RICHARD_PHONE_ALT}}': c.richardPhoneAlt,
    '{{HOST_JEROME_PHONE_E164}}': c.jeromePhoneE164,
    '{{HOST_RUBY_PHONE_E164}}': c.rubyPhoneE164,
    '{{HOST_PM_NAME}}': c.propertyManagerName,
    '{{WIFI_SSID}}': c.wifiSsid,
    '{{WIFI_PASSWORD}}': c.wifiPassword,
    '{{OWNER_EMAIL}}': c.ownerEmail,
    '{{APT2_STREET_LOCKBOX_CODE}}': c.apt2StreetLockboxCode,
    '{{BACKUP_DOOR_CODE}}': c.backupDoorCode,
    '{{APT3_LOCKBOX_CODE}}': c.apt3LockboxCode,
  };
  let out = String(text || '');
  for (const [k, v] of Object.entries(map)) {
    out = out.split(k).join(v || k);
  }
  return out;
}

export function buildLuggageDropOffResponse(contacts = null) {
  const c = contacts || getHostContactsSync();
  const name = c.propertyManagerName || 'Richard';
  const phone = c.richardPhonePrimary || c.richardPhoneDisplay;
  return `Yes, you can coordinate an early luggage drop-off with ${name}, our on-site property manager, at ${phone}.`;
}

export function buildLuggageStorageResponse(contacts = null) {
  const c = contacts || getHostContactsSync();
  const name = c.propertyManagerName || 'Richard';
  const p1 = c.richardPhonePrimary || c.richardPhoneDisplay;
  const p2 = c.richardPhoneAlt || c.richardPhoneDisplay;
  const phones = p1 && p2 && p1 !== p2 ? `${p1} or ${p2}` : p1 || p2;
  return `${name}, our on-site property manager, can help with luggage storage after checkout. You can reach him at ${phones}.`;
}

export function buildApt2StreetDoorLockoutResponse(pinLast4 = null, contacts = null) {
  const c = contacts || getHostContactsSync();
  const code = c.apt2StreetLockboxCode || 'XXXX';
  const pinPhrase = pinLast4
    ? `your pin code ${pinLast4} (last 4 digits of the phone number on your reservation)`
    : 'your pin code (the last 4 digits of the phone number on your reservation)';
  const jerome = c.jeromePhoneDisplay || 'the host';
  const ruby = c.rubyPhoneDisplay || 'our co-host';
  const richard = c.richardPhoneDisplay || c.richardPhoneAlt || 'our property manager';
  return (
    `Sorry you're locked out! On the street entrance door on the right, you will see two lock boxes. ` +
    `The one at the top has the backup key — open it by rotating the digits to ${code}. ` +
    `Once you open the street door, put the key back in the lock box right away. ` +
    `After you go up the stairs, use ${pinPhrase} to enter the unit. ` +
    `If you have any trouble, call me at ${jerome}, my wife Ruby at ${ruby}, or Richard at ${richard}.`
  );
}

/** Digits-only fragments useful for "has phone already" checks in policies. */
export function phoneDigitHints(contacts = null) {
  const c = contacts || getHostContactsSync();
  const raw = [
    c.jeromePhoneDisplay,
    c.rubyPhoneDisplay,
    c.richardPhonePrimary,
    c.richardPhoneAlt,
    c.richardPhoneDisplay,
  ]
    .filter(Boolean)
    .join(' ');
  const digits = raw.replace(/\D/g, '');
  const hints = new Set();
  if (digits.length >= 7) hints.add(digits.slice(-7));
  if (digits.length >= 4) hints.add(digits.slice(-4));
  // Also last-7 of each number separately
  for (const p of [c.richardPhonePrimary, c.richardPhoneAlt, c.jeromePhoneDisplay, c.rubyPhoneDisplay]) {
    const d = String(p || '').replace(/\D/g, '');
    if (d.length >= 7) hints.add(d.slice(-7));
  }
  return [...hints];
}
