import { GrokLLMAdapter } from './grok.js';

export function createLLMAdapter(preferred = 'auto') {
  const hasKey = !!process.env.GROK_API_KEY;

  if (preferred === 'mock') {
    throw new Error(
      'Mock LLM has been permanently removed. ' +
      'Set GROK_API_KEY and use the real Grok model.'
    );
  }

  if (preferred === 'grok' || (preferred === 'auto' && hasKey)) {
    return new GrokLLMAdapter();
  }

  throw new Error(
    'No GROK_API_KEY found. Real Grok is required. ' +
    'Set the GROK_API_KEY environment variable.'
  );
}
