/**
 * LLM routing for the guest-messaging harness.
 *
 * Draft (guest-facing) uses grok-4.3 at low temperature.
 * Reviewer (merged reflection + conversation judge) uses grok-3-mini.
 */

export const DRAFT_MODEL = 'grok-4.3';
export const REVIEWER_MODEL = 'grok-3-mini';
export const DRAFT_TEMPERATURE = 0.2;
export const REVIEWER_TEMPERATURE = 0.1;
export const REWRITE_TEMPERATURE = 0.2;
export const DEFAULT_MAX_TOKENS = 2000;

export const DRAFT_LLM_OPTIONS = Object.freeze({
  model: DRAFT_MODEL,
  temperature: DRAFT_TEMPERATURE,
  max_tokens: DEFAULT_MAX_TOKENS,
  role: 'draft',
});

export const REVIEWER_LLM_OPTIONS = Object.freeze({
  model: REVIEWER_MODEL,
  temperature: REVIEWER_TEMPERATURE,
  max_tokens: DEFAULT_MAX_TOKENS,
  role: 'reviewer',
  fallbackModel: DRAFT_MODEL,
});

export const REWRITE_LLM_OPTIONS = Object.freeze({
  model: DRAFT_MODEL,
  temperature: REWRITE_TEMPERATURE,
  max_tokens: DEFAULT_MAX_TOKENS,
  role: 'rewrite',
});
