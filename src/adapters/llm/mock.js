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

    // Very simple heuristic mock — used only for fast local eval + unit tests while porting the original 65 categories.
    // IMPORTANT: These are deliberately specific to current goldens. As we add more scenarios from the old production set,
    // this ladder will be replaced by a proper test-data registry (see future TODO in eval/runner or a new mock-data/ folder).
    // Order: most specific first to avoid accidental overlaps (e.g. "booking" + "cancel my booking").
    const lower = (userPrompt || '').toLowerCase();

    // 1. Michele inquiry (very specific date + name combo from original production test)
    if (lower.includes('michele') || (lower.includes('today') && lower.includes('saturday'))) {
      return JSON.stringify({
        typeOfMessageReceived: 'NEW_INQUIRY_WELCOME',
        proposedResponse: "Good morning Michele!\n\nThank you for your inquiry! My wife Ruby and I would be delighted to host you. Looking forward to potentially hosting you!\n\nWarm regards,\nJerome & Ruby",
        shouldReply: true,
        confidence: 0.9,
        notes: 'Mock response for Michele inquiry test'
      });
    }

    // 2. Josh cleaning complaint (very specific phrases)
    if (lower.includes('trash') || lower.includes('linen') || lower.includes('checkout')) {
      return JSON.stringify({
        typeOfMessageReceived: 'CHECKOUT_TRASH_LINEN',
        proposedResponse: "Thank you for asking! For checkout:\n• Trash — no need to take it outside, just leave it in the unit and our cleaning team will take care of it!\n• Dirty linen (bed sheets and towels) — please leave them on the bathroom floor.",
        shouldReply: true,
        confidence: 0.95
      });
    }

    // 3. Cancellation 50% policy case — tied to the specific scenario (Sarah + timing language)
    if ((lower.includes('cancel') && (lower.includes('refund') || lower.includes('50%') || lower.includes('sarah'))) ||
        lower.includes('7 or more days away')) {
      return JSON.stringify({
        typeOfMessageReceived: 'CANCELLATION_POLICY',
        proposedResponse: "Hi Sarah,\n\nI'm sorry to hear your plans have changed.\n\nBecause you booked more than 24 hours ago and your check-in is 7 or more days away, you would receive a 50% refund (including taxes) if you cancel now.\n\nYou can cancel directly through your Airbnb reservation. For the official policy details, see: https://www.airbnb.com/help/article/475\n\nWarm regards,\nJerome & Ruby",
        shouldReply: true,
        confidence: 0.85,
        notes: 'Mock response for cancellation policy test'
      });
    }

    // 4. New reservation welcome with pet mismatch — tied to specific test signals (Mike + small dog + excited)
    if ((lower.includes('mike') && lower.includes('dog')) ||
        (lower.includes('excited') && lower.includes('small dog')) ||
        (lower.includes('booking with us') && lower.includes('dog'))) {
      return JSON.stringify({
        typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
        proposedResponse: "Hi Mike,\n\nThank you so much for booking with us! My wife Ruby and I are looking forward to hosting you.\n\nA few quick notes:\n- Check-in is anytime after 4pm (self-check-in with lockbox).\n- Dedicated parking spot is included right in front.\n\nI see you mentioned bringing a dog — our listing is set up for 0 pets. If you'd like to add one, please send an alteration request through Airbnb for the $30 pet fee.\n\nI'll send the full check-in instructions about 3 days before your arrival.\n\nWarm regards,\nJerome & Ruby",
        shouldReply: true,
        confidence: 0.9,
        notes: 'Mock response for new reservation welcome test'
      });
    }

    // 5. Cancellation full refund with prior host statement (anti-contradiction case)
    if (lower.includes('elena') || (lower.includes('cancel right away') && lower.includes('just booked'))) {
      return JSON.stringify({
        typeOfMessageReceived: 'CANCELLATION_POLICY',
        proposedResponse: "Hi Elena, thanks for letting me know. Given what we discussed earlier in this thread, I'd prefer to handle the cancellation details directly rather than restating the policy here.",
        shouldReply: false,
        confidence: 0.8,
        notes: 'Mock response for full refund + prior host commitment test (escalates)'
      });
    }

    // 6. Cancellation exception after prior policy answer (multi-turn safety case)
    if (lower.includes('priya') || (lower.includes('husband') && lower.includes('sick'))) {
      return JSON.stringify({
        typeOfMessageReceived: 'CANCELLATION_POLICY_EXCEPTION',
        proposedResponse: "I'm truly sorry to hear about your husband. Unfortunately, we don't make exceptions to the cancellation policy.",
        shouldReply: false,
        confidence: 0.85,
        notes: 'Mock response for exception after prior policy answer (escalates)'
      });
    }

    // 7. Same-day turnover welcome (unit not ready yet)
    if (lower.includes('derek') || (lower.includes('arriving in a couple of hours'))) {
      return JSON.stringify({
        typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
        proposedResponse: "Hi Derek, thank you! We're preparing the apartment after today's turnover and will message you as soon as it's ready for check-in.",
        shouldReply: true,
        confidence: 0.9,
        notes: 'Mock response for same-day turnover welcome'
      });
    }

    // 8. Early check-in on future booking where unit will be ready
    if (lower.includes('liam') || (lower.includes('11am') && lower.includes('early check-in'))) {
      return JSON.stringify({
        typeOfMessageReceived: 'EARLY_CHECKIN_QUESTION',
        proposedResponse: "Hi Liam, since there are no guests the night before your arrival, the apartment should be ready by late morning. Early check-in around 11am should work well. I'll confirm the exact time a couple days before you arrive.",
        shouldReply: true,
        confidence: 0.85,
        notes: 'Mock response for early check-in on ready unit'
      });
    }

    // 9. Multi-turn cancellation repetition risk
    if (lower.includes('marcus') || (lower.includes('following up') && lower.includes('refund change'))) {
      return JSON.stringify({
        typeOfMessageReceived: 'CANCELLATION_POLICY',
        proposedResponse: "Hi Marcus, the timing looks the same as yesterday so the 50% refund would still apply. The official details are always at https://www.airbnb.com/help/article/475. Let me know if anything else comes up.",
        shouldReply: true,
        confidence: 0.8,
        notes: 'Mock response for multi-turn cancellation (varied language)'
      });
    }

    // 10. Wrong entrance - Gas station path (real recurring production issue for Apt 2)
    if (lower.includes('alex') && lower.includes('front of the building')) {
      return JSON.stringify({
        typeOfMessageReceived: 'CHECKIN_LOCATION_GUIDANCE',
        proposedResponse: "Hi Alex, it looks like you may be at the front of the building. Units don't have a lockbox there - the entrance is at the back of the building near the parking area. Look for the path between the gas station and the building.",
        shouldReply: true,
        confidence: 0.95,
        notes: 'Mock for real wrong-entrance gas station scenario'
      });
    }

    // 11. Snow plowing service (real winter question)
    if (lower.includes('jordan') && lower.includes('plow')) {
      return JSON.stringify({
        typeOfMessageReceived: 'PARKING_PLOWING_SERVICE',
        proposedResponse: "Yes, we do have a snow plowing service for the parking area during winter weather. Your dedicated spot will be cleared.",
        shouldReply: true,
        confidence: 0.9,
        notes: 'Mock for real snow plowing production scenario'
      });
    }

    // 12. Parking occupied by cleaning team on same-day turnover (real operational case)
    if (lower.includes('taylor') && lower.includes("we're here")) {
      return JSON.stringify({
        typeOfMessageReceived: 'PARKING',
        proposedResponse: "Hi Taylor, welcome! The cleaning team is currently using the parking spot while preparing the unit after today's turnover. They'll move as soon as they're done and we'll message you right away.",
        shouldReply: true,
        confidence: 0.9,
        notes: 'Mock for real cleaning team parking on turnover day'
      });
    }

    // Default safe response (anything not yet ported from the old 65-category set)
    return JSON.stringify({
      typeOfMessageReceived: 'OTHER_MESSAGE',
      proposedResponse: 'none',
      shouldReply: false,
      confidence: 0.6,
      notes: 'Mock adapter did not recognize a strong category'
    });
  }
}
