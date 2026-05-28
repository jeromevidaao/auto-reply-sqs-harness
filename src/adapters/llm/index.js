import { MockLLMAdapter } from './mock.js';
import { GrokLLMAdapter } from './grok.js';

export function createLLMAdapter(preferred = 'auto') {
  const hasKey = !!process.env.GROK_API_KEY;

  if (preferred === 'mock') {
    return new MockLLMAdapter();
  }

  if (preferred === 'grok' || (preferred === 'auto' && hasKey)) {
    try {
      return new GrokLLMAdapter();
    } catch (e) {
      console.warn('Failed to create real Grok adapter, falling back to mock:', e.message);
      return new MockLLMAdapter();
    }
  }

  return new MockLLMAdapter();
}
