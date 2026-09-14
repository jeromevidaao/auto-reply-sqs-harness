#!/usr/bin/env node
/**
 * Replay Rebecca Simpkin post-stay thank-you as message.created onto grok_message.
 * Uses AWS CLI (client-sqs is not a harness dependency).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadPath =
  process.argv[2] ||
  path.join(__dirname, '../test-payloads/rebecca-review-promise-replay.json');
const QUEUE =
  process.env.GROK_MESSAGE_QUEUE_URL ||
  'https://sqs.us-east-1.amazonaws.com/834917996497/grok_message';

const r = spawnSync(
  'aws',
  ['sqs', 'send-message', '--queue-url', QUEUE, '--message-body', `file://${payloadPath}`, '--output', 'json'],
  { encoding: 'utf8' }
);
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(r.status || 1);
}
console.log(r.stdout);
