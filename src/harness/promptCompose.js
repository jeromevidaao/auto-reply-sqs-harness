/**
 * Compose first-pass vs reviewer system prompts.
 *
 * First pass: base.md + routed category files + property file.
 * Reviewer: conversation-judge.md + reflection.md (merged checklist).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { applyHostContactPlaceholders } from '../config/hostContacts.js';
import {
  REVIEWER_CATEGORY_FILES,
  routeCategoryFiles,
} from './categoryRouter.js';
import { isHomeExchangeContext } from '../useCases/homeExchangeSharedCategories.js';

const promptCache = new Map();

export function promptCacheKey({ listingId = '', files = [], he = false, mode = 'first-pass' }) {
  return `${mode}|${he ? 'he' : 'abnb'}|${listingId || '-'}|${[...files].sort().join(',')}`;
}

export function clearPromptCache() {
  promptCache.clear();
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

export const PROPERTY_FILE_BY_LISTING = {
  'c899481f-2e5b-402d-80c4-3167fd824d96': '1b.md',
  '20904545': '1b.md',
  '114663c5-0709-4eff-a868-fa9ebd6ed42d': 'apt2.md',
  '20150380': 'apt2.md',
  '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd': 'apt3.md',
  '24259977': 'apt3.md',
};

export function propertyFileForListing(listingId) {
  if (!listingId) return null;
  return PROPERTY_FILE_BY_LISTING[String(listingId)] || null;
}

/**
 * @returns {Promise<{ text: string, selectedFiles: string[], reasons: string[], chars: number, usedFallback: boolean }>}
 */
export async function composeFirstPassPrompt({
  promptPath,
  propertiesDir,
  categoriesDir,
  context = {},
  guestMessage = '',
} = {}) {
  const routed = routeCategoryFiles({
    guestMessage: guestMessage || context.guestMessage || context.originalMessage || '',
    context,
  });

  const listingId = context.listingId || context.listing_id || '';
  const propertyFile = propertyFileForListing(listingId);
  const cacheKey = promptCacheKey({
    listingId,
    files: routed.files,
    he: isHomeExchangeContext(context),
    mode: 'first-pass',
  });
  if (promptCache.has(cacheKey)) {
    return promptCache.get(cacheKey);
  }

  const base = await readIfExists(promptPath);
  let categoryKnowledge = '';
  const loaded = [];
  for (const catFile of routed.files) {
    if (REVIEWER_CATEGORY_FILES.has(catFile)) continue;
    const content = await readIfExists(path.join(categoriesDir, catFile));
    if (!content) continue;
    categoryKnowledge += `\n\n## ${catFile.replace('.md', '')}\n${content.trim()}`;
    loaded.push(catFile);
  }

  let propertyKnowledge = '';
  if (propertyFile && propertiesDir) {
    propertyKnowledge = await readIfExists(path.join(propertiesDir, propertyFile));
  }

  const text = applyHostContactPlaceholders([
    String(base || '').trim(),
    categoryKnowledge ? `\n\n# Category Rules\n${categoryKnowledge}` : '',
    propertyKnowledge ? `\n\n# Property-Specific Knowledge\n${propertyKnowledge}` : '',
  ].join(''));

  const result = {
    text,
    selectedFiles: loaded,
    reasons: routed.reasons,
    chars: text.length,
    usedFallback: routed.usedFallback,
  };
  promptCache.set(cacheKey, result);
  return result;
}

/**
 * Merged reflection + conversation judge instructions (reviewer pass only).
 */
export async function composeReviewerPrompt({ categoriesDir } = {}) {
  const cacheKey = 'reviewer|merged';
  if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);

  const judge = await readIfExists(path.join(categoriesDir, 'conversation-judge.md'));
  const reflection = await readIfExists(path.join(categoriesDir, 'reflection.md'));
  const text = applyHostContactPlaceholders([
    String(judge || '').trim(),
    '',
    '---',
    '',
    '# Merged reflection checklist (no separate LLM reflection pass)',
    'Apply these checks in the SAME verdict. Do not ask for another model call.',
    String(reflection || '').trim(),
  ].join('\n'));

  const result = { text, chars: text.length };
  promptCache.set(cacheKey, result);
  return result;
}
