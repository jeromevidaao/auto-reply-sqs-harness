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
