/**
 * Upload the three unit check-in templates to private S3.
 *   node scripts/upload-checkin-templates.js
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CHECKIN_TEMPLATE_BUCKET,
  CHECKIN_TEMPLATE_PREFIX,
  CHECKIN_TEMPLATE_BY_HOME,
} from '../src/useCases/checkinTemplates/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '../src/useCases/checkinTemplates');
const s3 = new S3Client({ region: 'us-east-1' });

const files = [...new Set(Object.values(CHECKIN_TEMPLATE_BY_HOME))];

for (const unitKey of files) {
  const body = readFileSync(join(DIR, `${unitKey}.json`));
  const parsed = JSON.parse(body.toString('utf8'));
  if (parsed.unitKey !== unitKey) {
    throw new Error(`${unitKey}.json unitKey mismatch`);
  }
  const Key = `${CHECKIN_TEMPLATE_PREFIX.replace(/\/$/, '')}/${unitKey}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: CHECKIN_TEMPLATE_BUCKET,
      Key,
      Body: body,
      ContentType: 'application/json',
    })
  );
  console.log(`uploaded s3://${CHECKIN_TEMPLATE_BUCKET}/${Key} homeId=${parsed.homeId}`);
}
