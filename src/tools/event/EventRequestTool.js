import { BaseTool } from '../BaseTool.js';
import {
  isAdditionalParkingAsk,
  isEventHostingAsk,
  isEventHostingDenial,
  isTripPurposeEventMention,
} from '../parking/additionalParking.js';

/**
 * EventRequestTool
 *
 * Detects and handles requests to host events, parties, gatherings, etc.
 * These are almost always declined.
 *
 * John Apt 2 2026-08-26: do NOT treat trip-purpose weddings ("celebration of
 * our niece's wedding"), additional-parking asks, or "not looking to plan a
 * gathering" clarifications as EVENT_REQUEST.
 */
export const EVENT_REQUEST_STANDARD_RESPONSE =
  "Thank you for thinking of our place for your event! Unfortunately, we're not able to accommodate events or gatherings as this is a residential building and our apartment isn't set up for those types of activities. We appreciate your understanding and hope you find a perfect venue for your celebration!";

export class EventRequestTool extends BaseTool {
  constructor() {
    super({
      name: 'handle_event_request',
      description: 'Detects requests to host events/parties/gatherings and returns the standard decline response with context.',
    });
  }

  async execute(input, context = {}) {
    const message = typeof input === 'string' ? input : (input?.message || '');
    const lower = message.toLowerCase();

    // Checkout/housekeeping false positive (Rene incident): "gathered all of the trash"
    if (/\bgathered\b/.test(lower) && /\b(trash|garbage|linens?|laundry|recycl)/i.test(lower)) {
      return { detected: false };
    }

    if (isEventHostingDenial(message)) {
      return { detected: false, deniedEvent: true };
    }

    if (isAdditionalParkingAsk(message) && !isEventHostingAsk(message)) {
      return { detected: false, additionalParking: true };
    }

    if (isTripPurposeEventMention(message)) {
      return { detected: false, tripPurpose: true };
    }

    const isEventRequest = isEventHostingAsk(message) ||
      /\b(?:event|party|gathering|get[- ]?together|celebration|meeting|birthday party|hosting|people over)\b/i.test(lower) ||
      /\bhost\b.*\b(?:party|event|people|gathering)\b/i.test(lower);

    if (!isEventRequest) {
      return { detected: false };
    }

    return {
      detected: true,
      category: 'EVENT_REQUEST',
      standardResponse: EVENT_REQUEST_STANDARD_RESPONSE,
      needsEscalation: false,
    };
  }
}
