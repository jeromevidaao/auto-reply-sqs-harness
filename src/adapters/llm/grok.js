/**
 * Real Grok (xAI) Adapter.
 * Requires GROK_API_KEY in the environment.
 *
 * Per-call options override the constructor defaults so the harness can
 * send the guest-facing draft on grok-4.3 (temp 0.2) and the reviewer on
 * grok-3-mini (temp 0.1) without two adapter instances.
 */

import {
  DRAFT_MODEL,
  DRAFT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  REVIEWER_MODEL,
} from '../../harness/models.js';

export class GrokLLMAdapter {
  constructor(options = {}) {
    this.name = 'grok';
    this.apiKey = options.apiKey || process.env.GROK_API_KEY;
    this.baseURL = options.baseURL || 'https://api.x.ai/v1';
    this.model = options.model || DRAFT_MODEL;
    this.fallbackModel = options.fallbackModel || REVIEWER_MODEL;
    this.temperature = options.temperature ?? DRAFT_TEMPERATURE;
    this.maxTokens = options.max_tokens || DEFAULT_MAX_TOKENS;
  }

  async complete(systemPrompt, userPrompt, callOptions = {}) {
    if (!this.apiKey) {
      throw new Error('GROK_API_KEY is not set. Cannot call real Grok API.');
    }

    const model = callOptions.model || this.model;
    const temperature = callOptions.temperature ?? this.temperature;
    const maxTokens = callOptions.max_tokens || this.maxTokens;
    const role = callOptions.role || 'draft';
    const fallbackModel = callOptions.fallbackModel || this.fallbackModel;

    try {
      return await this._completeOnce({
        model,
        temperature,
        maxTokens,
        systemPrompt,
        userPrompt,
        role,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const canFallback =
        fallbackModel &&
        fallbackModel !== model &&
        (/model/i.test(msg) || /404/.test(msg) || /not found/i.test(msg) || /503/.test(msg) || /529/.test(msg));
      if (!canFallback) throw err;
      console.warn(`[Grok] ${role} model ${model} failed (${msg.slice(0, 180)}); falling back to ${fallbackModel}`);
      return this._completeOnce({
        model: fallbackModel,
        temperature,
        maxTokens,
        systemPrompt,
        userPrompt,
        role: `${role}-fallback`,
      });
    }
  }

  async _completeOnce({ model, temperature, maxTokens, systemPrompt, userPrompt, role }) {
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
    };

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'x-api-version': '2023-12-01-preview',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 529 || res.status === 503 || text.includes('capacity')) {
        console.warn(`⚠️  Grok capacity issue on ${model} (${role})`);
      }
      throw new Error(`Grok API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    console.log(
      `[Grok] ${role} model=${model} temp=${temperature} chars_in=${systemPrompt.length + userPrompt.length} chars_out=${content.length}`
    );
    return content;
  }
}
