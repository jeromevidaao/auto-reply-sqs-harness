/**
 * Per-unit HE / Airbnb 3-day check-in instruction templates.
 * S3 is the live source; bundled JSON is the fallback so a missing object
 * never sends the wrong unit's door instructions.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const CHECKIN_TEMPLATE_BUCKET =
  process.env.CHECKIN_TEMPLATE_S3_BUCKET || 'cleaningbutton-ai-context-us-east-1';
export const CHECKIN_TEMPLATE_PREFIX =
  process.env.CHECKIN_TEMPLATE_S3_PREFIX || 'data/checkin-templates';

export const CHECKIN_TEMPLATE_BY_HOME = {
  '3285159': 'apt-1b',
  '3285044': 'apt-2',
  '3202475': 'apt-3',
};

const BUNDLED = {
  'apt-1b': JSON.parse(readFileSync(join(HERE, 'apt-1b.json'), 'utf8')),
  'apt-2': JSON.parse(readFileSync(join(HERE, 'apt-2.json'), 'utf8')),
  'apt-3': JSON.parse(readFileSync(join(HERE, 'apt-3.json'), 'utf8')),
};

export function templateKeyForHomeId(homeId) {
  const key = homeId != null ? String(homeId).trim() : '';
  return CHECKIN_TEMPLATE_BY_HOME[key] || null;
}

export function bundledCheckinTemplate(homeId) {
  const unitKey = templateKeyForHomeId(homeId);
  if (!unitKey) return null;
  const tpl = BUNDLED[unitKey];
  if (!tpl) return null;
  if (String(tpl.homeId) !== String(homeId)) return null;
  return structuredClone(tpl);
}

export function s3KeyForHomeId(homeId) {
  const unitKey = templateKeyForHomeId(homeId);
  if (!unitKey) return null;
  return `${CHECKIN_TEMPLATE_PREFIX.replace(/\/$/, '')}/${unitKey}.json`;
}

function parseTemplateJson(raw, homeId) {
  const tpl = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!tpl || typeof tpl !== 'object') return null;
  if (String(tpl.homeId) !== String(homeId)) return null;
  if (typeof tpl.template !== 'string' || !tpl.template.includes('{last4}')) return null;
  return tpl;
}

export async function loadCheckinTemplate({ homeId, s3Client = null } = {}) {
  const key = s3KeyForHomeId(homeId);
  if (!key) {
    return { template: null, source: null, error: 'unknown_home_id' };
  }
  if (s3Client && typeof s3Client.send === 'function') {
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const resp = await s3Client.send(
        new GetObjectCommand({
          Bucket: CHECKIN_TEMPLATE_BUCKET,
          Key: key,
        })
      );
      const raw = await resp.Body.transformToString();
      const tpl = parseTemplateJson(raw, homeId);
      if (tpl) return { template: tpl, source: 's3', error: null };
      return {
        template: bundledCheckinTemplate(homeId),
        source: 'bundled',
        error: 's3_template_home_mismatch',
      };
    } catch (err) {
      const bundled = bundledCheckinTemplate(homeId);
      return {
        template: bundled,
        source: bundled ? 'bundled' : null,
        error: err?.message || String(err),
      };
    }
  }
  const bundled = bundledCheckinTemplate(homeId);
  return {
    template: bundled,
    source: bundled ? 'bundled' : null,
    error: bundled ? null : 'missing_bundled_template',
  };
}

/** Lookup indexes built from bundled Pine St / West End Victorian templates. */
const WIFI_BY_ID = (() => {
  const map = new Map();
  for (const tpl of Object.values(BUNDLED)) {
    const ssid = tpl?.critical?.wifiNetwork || null;
    const password = tpl?.critical?.wifiPassword || null;
    if (!ssid || !password) continue;
    const creds = { ssid, password, unitKey: tpl.unitKey || null, source: 'checkinTemplate' };
    for (const id of [tpl.propertyId, tpl.airbnbListingId, tpl.homeId, String(tpl.homeId || '')]) {
      if (id) map.set(String(id).trim(), creds);
    }
  }
  return map;
})();

/**
 * Property-aware WiFi for Pine St / West End Victorian units (apt-1b/2/3).
 * Returns Pineland / lobsterbake from check-in templates — never the global
 * hostContacts Ansia_2.4 / 10286500 for these listings.
 *
 * @param {object} context
 * @returns {{ ssid: string, password: string, unitKey?: string, source: string } | null}
 */
export function wifiCredentialsFromCheckinTemplate(context = {}) {
  const ids = [
    context.listingId,
    context.listing_id,
    context.propertyId,
    context.property_id,
    context.airbnbListingId,
    context.airbnb_listing_id,
    context.listing?.platform_id,
    context.listing?.platformId,
    context.homeId,
    context.home_id,
    context.property?.id,
  ]
    .filter(Boolean)
    .map((x) => String(x).trim());

  for (const id of ids) {
    const hit = WIFI_BY_ID.get(id);
    if (hit) return { ...hit };
  }

  const name = String(
    context.propertyName || context.listingName || context.property?.name || context.property?.public_name || ''
  ).toLowerCase();
  if (!name) return null;

  // All Pine St / West End Victorian units share Pineland / lobsterbake.
  if (
    /pine\s*st|west\s*end\s*victorian|53\s*pine|cozy.*victorian|sunny.*victorian|downtown studio|apt\s*#?\s*[123]|#\s*[123]\b|1b\b/.test(
      name
    )
  ) {
    // Prefer apt-3 template values (canonical); all three units match.
    const any = WIFI_BY_ID.get('24259977') || WIFI_BY_ID.get('20150380') || WIFI_BY_ID.get('20904545');
    if (any) return { ...any, unitKey: any.unitKey || 'pine-st', source: 'checkinTemplate:name' };
  }
  return null;
}

/** Known-wrong global SSID/password that must never be sent for Pine units. */
export const FORBIDDEN_PINE_WIFI = Object.freeze({
  ssid: 'Ansia_2.4',
  password: '10286500',
});

export function draftContainsForbiddenPineWifi(draft = '') {
  const d = String(draft || '').toLowerCase();
  return (
    d.includes(FORBIDDEN_PINE_WIFI.ssid.toLowerCase()) ||
    d.includes(FORBIDDEN_PINE_WIFI.password.toLowerCase())
  );
}
