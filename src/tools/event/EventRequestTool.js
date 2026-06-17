import { BaseTool } from '../BaseTool.js';

/**
 * EventRequestTool
 *
 * Detects and handles requests to host events, parties, gatherings, etc.
 * These are almost always declined.
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

    const isEventRequest = /event|party|gather|get[- ]?together|celebration|meeting|birthday party|hosting|people over/i.test(message.toLowerCase());

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
