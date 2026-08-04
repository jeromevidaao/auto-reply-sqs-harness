#!/usr/bin/env node
/**
 * Capture a production auto-reply miss as an eval golden (Grok CI).
 *
 * Usage:
 *   node scripts/add-production-miss-scenario.js \
 *     --message 'Sounds great! Thank you! And what is the latest time we are able to check out Monday?' \
 *     --id latest-checkout-monday \
 *     --category THANK_YOU_MESSAGE,CHECKOUT \
 *     --required '10am,checkout is strictly' \
 *     --guest Cassidy \
 *     --listing 114663c5-0709-4eff-a868-fa9ebd6ed42d \
 *     --property 'Sunny Apt 2'
 *
 * Writes: eval/scenarios/<id>.json
 * Then: npm test && npm run eval (CI does this on push).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProductionMissScenario } from '../src/utils/replyPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const scenariosDir = path.join(root, 'eval', 'scenarios');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function splitCsv(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const message = args.message || args.msg || args.m;
  const id = args.id || args.slug;
  if (!message || !id) {
    console.error(`Usage: node scripts/add-production-miss-scenario.js --id <slug> --message "..." [options]

Options:
  --category CAT[,CAT]     expectedCategory
  --required phrase,phrase requiredPhrases (substrings, case-insensitive)
  --forbidden phrase,...   forbiddenPhrases
  --min-confidence 0.95    minConfidence (default 0.95)
  --guest Name
  --listing uuid
  --property "Name"
  --check-in YYYY-MM-DD
  --check-out YYYY-MM-DD
  --description "..."
  --notes "..."
  --force                  overwrite existing scenario file
`);
    process.exit(1);
  }

  const scenario = buildProductionMissScenario({
    id,
    guestMessage: message,
    description: args.description,
    expectedCategory: splitCsv(args.category),
    requiredPhrases: splitCsv(args.required),
    forbiddenPhrases: splitCsv(args.forbidden),
    minConfidence: parseFloat(args['min-confidence'] || args.minConfidence || '0.95') || 0.95,
    notes: args.notes,
    context: {
      guestName: args.guest || 'Guest',
      listingId: args.listing || null,
      propertyName: args.property || null,
      checkIn: args['check-in'] || args.checkIn || null,
      checkOut: args['check-out'] || args.checkOut || null,
    },
  });

  // Drop empty expectedCategory array
  if (
    scenario.rubric.expectedCategory &&
    scenario.rubric.expectedCategory.length === 0
  ) {
    delete scenario.rubric.expectedCategory;
  }

  const file = path.join(scenariosDir, `${scenario.id}.json`);
  if (fs.existsSync(file) && !args.force) {
    console.error(`Refusing to overwrite ${file} (pass --force)`);
    process.exit(2);
  }

  fs.mkdirSync(scenariosDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(scenario, null, 2) + '\n', 'utf8');
  console.log(`✅ Wrote production-miss eval scenario: ${path.relative(root, file)}`);
  console.log(`   shouldAlwaysReply=true minConfidence=${scenario.rubric.minConfidence}`);
  console.log(`   Next: git add ${path.relative(root, file)} && npm test && git commit && git push`);
  console.log(`   CI runs live Grok eval on every PR/main — this scenario will gate deploy.`);
}

main();
