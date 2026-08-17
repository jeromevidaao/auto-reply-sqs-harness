#!/usr/bin/env node
/**
 * Local gate that must be green before pushing this repo.
 *
 *   npm run prepush
 *
 * Skill guest-messaging-harness / scripts/prepush.py loads GROK_API_KEY from
 * SSM /grok/api-key then runs this. Do not skip live eval when guest-facing
 * files changed — that is how required-phrase CI failures happen.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const LIVE_PREFIXES = [
  'eval/scenarios/',
  'eval/goldens/',
  'prompts/',
  'src/',
  'tests/',
  'lambda/',
];

const SKIP_LIVE = [
  /^AGENTS\.md$/,
  /^README\.md$/,
  /^ROADMAP\.md$/,
  /^docs\//,
  /^\.github\//,
  /^scripts\/check-eval-phrases\.js$/,
  /^scripts\/prepush\.js$/,
];

function run(cmd, args, { requireZero = true } = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}\n`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (requireZero && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.status ?? 0;
}

function gitNames(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return String(result.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function changedPaths() {
  return [
    ...new Set([
      ...gitNames(['diff', '--name-only']),
      ...gitNames(['diff', '--name-only', '--cached']),
      ...gitNames(['diff', '--name-only', 'origin/main...HEAD']),
      ...gitNames(['ls-files', '--others', '--exclude-standard']),
    ]),
  ];
}

function needsLiveEval(paths) {
  return paths.some((p) => {
    if (SKIP_LIVE.some((re) => re.test(p))) return false;
    return LIVE_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
  });
}

function changedScenarioIds(paths) {
  const ids = new Set();
  for (const p of paths) {
    const m = p.match(/^eval\/(?:scenarios|goldens)\/([^/]+)\.(?:json|md)$/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

function main() {
  console.log('=== harness prepush ===');

  run('node', [path.join(root, 'scripts/check-eval-phrases.js')]);
  run('npm', ['test']);

  const paths = changedPaths();
  const live = needsLiveEval(paths);
  if (!live) {
    console.log('\nNo guest-facing / eval files in the diff — skipping live Grok eval.');
    console.log('PREPUSH OK');
    return;
  }

  if (!process.env.GROK_API_KEY) {
    console.error(
      '\nFAIL: GROK_API_KEY is not set. Load it from SSM /grok/api-key (skill guest-messaging-harness / scripts/prepush.py). Do not push without a local live eval.'
    );
    process.exit(1);
  }

  const ids = changedScenarioIds(paths);
  if (ids.length > 0) {
    console.log(`\nTargeted eval first: ${ids.join(', ')}`);
    run('node', [path.join(root, 'eval/runner.js'), `--only=${ids.join(',')}`]);
  }

  console.log('\nFull live eval (no fail-fast) — same suite as CI, all failures visible.');
  run('node', [path.join(root, 'eval/runner.js')]);

  console.log('\nPREPUSH OK');
}

main();
