#!/usr/bin/env node
/**
 * Static eval-rubric gate (no Grok).
 *
 * Catches the class of CI failure where requiredPhrases were added to a
 * golden/scenario but the seeded tool snippet — the text the policy actually
 * forces into the draft — does not contain them.
 *
 * Usage: node scripts/check-eval-phrases.js
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const scenariosDir = path.join(root, 'eval/scenarios');
const goldensDir = path.join(root, 'eval/goldens');

function collectSnippets(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectSnippets(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'suggestedResponseSnippet' && typeof child === 'string' && child.trim()) {
      out.push(child);
    } else {
      collectSnippets(child, out);
    }
  }
  return out;
}

function includesInsensitive(haystack, needle) {
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

async function main() {
  const files = (await fs.readdir(scenariosDir)).filter((f) => f.endsWith('.json'));
  const errors = [];
  const warnings = [];
  let checked = 0;

  for (const file of files.sort()) {
    const id = file.replace(/\.json$/, '');
    const scenarioPath = path.join(scenariosDir, file);
    const goldenPath = path.join(goldensDir, `${id}.md`);
    let scenario;
    try {
      scenario = JSON.parse(await fs.readFile(scenarioPath, 'utf8'));
    } catch (err) {
      errors.push(`${id}: invalid JSON (${err.message})`);
      continue;
    }

    try {
      await fs.access(goldenPath);
    } catch {
      warnings.push(`${id}: missing golden ${path.relative(root, goldenPath)}`);
    }

    const rubric = scenario.rubric || {};
    const required = Array.isArray(rubric.requiredPhrases) ? rubric.requiredPhrases : [];
    const forbidden = Array.isArray(rubric.forbiddenPhrases) ? rubric.forbiddenPhrases : [];
    const forceCover =
      scenario.productionMiss === true || rubric.shouldAlwaysReply === true;

    // Satisfying required must not guarantee a forbidden hit.
    // "ready" vs "happy to have one ready" is fine; identical or forbidden⊆required is not.
    for (const phrase of required) {
      const clash = forbidden.find(
        (f) =>
          String(f).toLowerCase() === String(phrase).toLowerCase() ||
          includesInsensitive(phrase, f)
      );
      if (clash) {
        errors.push(
          `${id}: required phrase ${JSON.stringify(phrase)} contains forbidden ${JSON.stringify(clash)}`
        );
      }
    }

    const snippets = collectSnippets(scenario.context || {});
    if (snippets.length === 0 || required.length === 0) continue;

    checked += 1;
    const blob = snippets.join('\n');
    for (const phrase of required) {
      if (includesInsensitive(blob, phrase)) continue;
      const msg = `${id}: required phrase ${JSON.stringify(phrase)} is not in seeded suggestedResponseSnippet`;
      if (forceCover) errors.push(msg);
      else warnings.push(msg);
    }
  }

  if (warnings.length) {
    console.log('Warnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (errors.length) {
    console.error('eval phrase check FAILED');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `eval phrase check OK (${files.length} scenarios, ${checked} with seeded snippets)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
