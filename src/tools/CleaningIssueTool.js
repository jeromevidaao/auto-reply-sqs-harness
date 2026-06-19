import { BaseTool } from './BaseTool.js';

/**
 * CleaningIssueTool
 *
 * Detects cleaning-related complaints in guest messages (especially post-stay feedback).
 * This is now implemented as a proper Tool.
 */
export class CleaningIssueTool extends BaseTool {
  constructor() {
    super({
      name: 'detect_cleaning_issue',
      description: 'Detects if a guest message contains complaints about cleaning issues (hair, stains, dirt, etc.). Returns structured details if found.',
    });

    this.cleaningPatterns = [
      'hair in the shower',
      'stained',
      'dirty',
      'not clean',
      'cleaning',
      'smells like',
      'dust',
      'ceiling tile',
      'ceiling tiles',
      'bathroom was dirty',
      'kitchen was dirty',
      'sheets were dirty',
      'towels were dirty',
      'didn’t clean',
      'wasn’t cleaned',
      'left hair',
      'found hair',
      // Housekeeping setup failures (cleaning team responsibility — Amy incident)
      'no sheets',
      'no sheet',
      'were no sheets',
      'missing sheets',
      'no linens',
      'no blankets',
      'no pillows',
      'no towels',
      'forgot to',
      'not stocked',
      'wasn\'t stocked',
      'was not stocked',
    ];
  }

  async execute(input, context = {}) {
    const message = typeof input === 'string' ? input : input?.message;

    if (!message || typeof message !== 'string') {
      return { detected: false };
    }

    const text = message.toLowerCase();
    const matched = this.cleaningPatterns.find(pattern => text.includes(pattern));

    if (!matched) {
      return { detected: false };
    }

    console.log('[CleaningIssueTool] Cleaning complaint detected. Matched phrase:', matched);

    const matchIndex = text.indexOf(matched);
    const start = Math.max(0, matchIndex - 80);
    const end = Math.min(text.length, matchIndex + matched.length + 120);
    const contextSnippet = message.substring(start, end).trim();

    return {
      detected: true,
      type: 'cleaning',
      matchedPhrase: matched,
      summary: `Guest mentioned a cleaning issue related to "${matched}".`,
      contextSnippet,
      fullMessage: message,
      reservation: {
        id: context.reservationId || context.id || null,
        guestName: context.guestName || null,
        checkIn: context.checkIn || null,
        checkOut: context.checkOut || null,
        propertyName: context.propertyName || null,
        listingId: context.listingId || null,
      },
    };
  }
}
