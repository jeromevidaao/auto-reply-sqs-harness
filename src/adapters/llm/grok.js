/**
 * Real Grok (xAI) Adapter.
 * Requires GROK_API_KEY in the environment.
 * Falls back behavior is handled by the caller if needed.
 */

export class GrokLLMAdapter {
  constructor(options = {}) {
    this.name = 'grok';
    this.apiKey = options.apiKey || process.env.GROK_API_KEY;
    this.baseURL = 'https://api.x.ai/v1';
    this.model = options.model || 'grok-4.3';
    this.fallbackModel = options.fallbackModel || 'grok-3-mini';
  }

  async complete(systemPrompt, userPrompt) {
    if (!this.apiKey) {
      throw new Error('GROK_API_KEY is not set. Cannot call real Grok API.');
    }

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    };

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'x-api-version': '2023-12-01-preview'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      // Simple capacity detection (matching the spirit of the original Lambda)
      if (res.status === 529 || res.status === 503 || text.includes('capacity')) {
        console.warn('⚠️  Grok capacity issue — would normally fall back (not implemented in this basic adapter yet)');
      }
      throw new Error(`Grok API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  }
}
