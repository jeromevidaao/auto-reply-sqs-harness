import { BaseTool } from './BaseTool.js';

/**
 * CleaningIssueTool
 *
 * Detects cleaning-related *complaints* in guest messages (especially post-stay feedback).
 * Must NOT fire on non-complaint uses of the word "cleaning" — e.g. Olivia offering an early
 * Sunday departure "so you can start the cleaning process early", pet "extra cleaning" fees,
 * or "if cleaning finishes before 4pm" logistics language.
 */
export class CleaningIssueTool extends BaseTool {
  constructor() {
    super({
      name: 'detect_cleaning_issue',
      description: 'Detects if a guest message contains complaints about cleaning issues (hair, stains, dirt, etc.). Returns structured details if found.',
    });

    // Strong complaint phrases (substring match is OK — these are multi-word / specific).
    this.cleaningPatterns = [
      'hair in the shower',
      'stained',
      'dirty',
      'not clean',
      'smells like',
      'dust',
      'ceiling tile',
      'ceiling tiles',
      'bathroom was dirty',
      'kitchen was dirty',
      'sheets were dirty',
      'towels were dirty',
      'didn’t clean',
      "didn't clean",
      'wasn’t cleaned',
      "wasn't cleaned",
      'was not cleaned',
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

    // Standalone "cleaning" only counts as a complaint when the surrounding wording
    // is not clearly logistics / early-departure courtesy / fee language.
    // Olivia 2026-07-30: "...start the cleaning process early" must NOT match.
    this.nonComplaintCleaningPatterns = [
      /\bcleaning\s+process\b/,
      /\bstart(?:ing)?\s+(?:the\s+)?cleaning\b/,
      /\bfor\s+(?:the\s+)?cleaning\b/,
      /\bcleaning\s+team\b/,
      /\bcleaning\s+fee\b/,
      /\bextra\s+cleaning\b/,
      /\bbefore\s+cleaning\b/,
      /\bafter\s+cleaning\b/,
      /\bcleaning\s+finishes?\b/,
      /\bcleaning\s+is\s+(?:done|finished|complete)\b/,
      /\bwhen\s+cleaning\b/,
      /\buntil\s+cleaning\b/,
      /\bcleaning\s+is\s+still\b/,
      /\bmessage\s+you\s+(?:when|as soon as).{0,40}\bcleaning\b/,
    ];
  }

  /**
   * True when "cleaning" appears only in non-complaint / logistics contexts
   * (or does not appear at all as a bare token worth escalating on).
   */
  _isNonComplaintCleaningMention(text = '') {
    if (!/\bcleaning\b/.test(text)) return false;
    // If any non-complaint pattern matches and there is no strong complaint pattern, treat as logistics.
    const hasNonComplaint = this.nonComplaintCleaningPatterns.some((re) => re.test(text));
    if (!hasNonComplaint) return false;
    const hasStrongComplaint = this.cleaningPatterns.some((p) => text.includes(p));
    return !hasStrongComplaint;
  }

  async execute(input, context = {}) {
    const message = typeof input === 'string' ? input : input?.message;

    if (!message || typeof message !== 'string') {
      return { detected: false };
    }

    const text = message.toLowerCase();

    // Prefer specific complaint phrases first (never bare "cleaning" alone).
    let matched = this.cleaningPatterns.find((pattern) => text.includes(pattern));

    // Bare "cleaning" only if it looks like a real complaint and is not logistics.
    if (!matched && /\bcleaning\b/.test(text) && !this._isNonComplaintCleaningMention(text)) {
      // Require complaint-ish neighborhood around "cleaning" (issue / problem / dirty / bad / poor / not).
      const complaintyCleaning =
        /\b(?:poor|bad|terrible|awful|issue|problem|complaint|dirty|not|never|wasn't|wasnt|didn'?t|was not)\b.{0,40}\bcleaning\b/.test(text) ||
        /\bcleaning\b.{0,40}\b(?:issue|problem|poor|bad|terrible|awful|dirty|not done|never done|incomplete)\b/.test(text) ||
        /\b(?:the\s+)?cleaning\s+(?:was|is)\s+(?:poor|bad|terrible|awful|incomplete|not)\b/.test(text);
      if (complaintyCleaning) {
        matched = 'cleaning';
      }
    }

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
