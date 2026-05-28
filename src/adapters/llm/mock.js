/**
 * Mock LLM Adapter — always works locally with no network or API key.
 * Used by default for fast iteration and tests.
 */

export class MockLLMAdapter {
  constructor(options = {}) {
    this.name = 'mock';
    this.delayMs = options.delayMs ?? 120;
    this.fixedResponse = options.fixedResponse || null;
  }

  async complete(systemPrompt, userPrompt) {
    await new Promise(r => setTimeout(r, this.delayMs));

    if (this.fixedResponse) {
      return this.fixedResponse;
    }

    // Very simple heuristic mock for the Michele-style inquiry test
    const lower = (userPrompt || '').toLowerCase();

    if (lower.includes('michele') || (lower.includes('today') && lower.includes('saturday'))) {
      return JSON.stringify({
        typeOfMessageReceived: 'NEW_INQUIRY_WELCOME',
        proposedResponse: "Good morning Michele!\n\nThank you for your inquiry! My wife Ruby and I would be delighted to host you. Looking forward to potentially hosting you!\n\nWarm regards,\nJerome & Ruby",
        shouldReply: true,
        confidence: 0.9,
        notes: 'Mock response for Michele inquiry test'
      });
    }

    if (lower.includes('trash') || lower.includes('linen') || lower.includes('checkout')) {
      return JSON.stringify({
        typeOfMessageReceived: 'CHECKOUT_TRASH_LINEN',
        proposedResponse: "Thank you for asking! For checkout:\n• Trash — no need to take it outside, just leave it in the unit and our cleaning team will take care of it!\n• Dirty linen (bed sheets and towels) — please leave them on the bathroom floor.",
        shouldReply: true,
        confidence: 0.95
      });
    }

    // Default safe response
    return JSON.stringify({
      typeOfMessageReceived: 'OTHER_MESSAGE',
      proposedResponse: 'none',
      shouldReply: false,
      confidence: 0.6,
      notes: 'Mock adapter did not recognize a strong category'
    });
  }
}
