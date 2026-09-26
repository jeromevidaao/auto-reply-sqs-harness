import { BaseTool } from './BaseTool.js';
import { looksLikeDirtyLinenDispositionAsk } from '../utils/dirtyLinenCheckout.js';

/**
 * CleaningIssueTool
 *
 * Detects cleaning-related *complaints* in guest messages (especially post-stay feedback).
 *
 * HARDENING (Olivia 2026-07-30): Must NOT fire on non-complaint uses of the word "cleaning"
 * — e.g. early Sunday departure "so you can start the cleaning process early", pet "extra
 * cleaning" fees, or "if cleaning finishes before 4pm" logistics language.
 *
 * Returns strength:
 *   - strong: real complaint phrases → may block auto-reply + alert
 *   - weak: ambiguous "cleaning" near complaint words → alert-only, never block auto-reply
 *   - (no detect): logistics-only mentions
 */
export class CleaningIssueTool extends BaseTool {
  constructor() {
    super({
      name: 'detect_cleaning_issue',
      description: 'Detects if a guest message contains complaints about cleaning issues (hair, stains, dirt, etc.). Returns structured details if found.',
    });

    // Strong complaint phrases (substring match is OK — these are multi-word / specific).
    // Bare "cleaning" is NEVER in this list.
    this.strongComplaintPatterns = [
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
      'forgot to put',
      'forgot to leave sheets',
      'forgot to stock',
      'forgot to make the bed',
      'not stocked',
      'wasn\'t stocked',
      'was not stocked',
      'poor cleaning',
      'bad cleaning',
      'terrible cleaning',
      'cleaning was poor',
      'cleaning was bad',
      'cleaning issue',
      'cleaning problem',
    ];

    // Back-compat alias used by older call sites / tests
    this.cleaningPatterns = this.strongComplaintPatterns;

    // Standalone "cleaning" only in logistics / courtesy / fee language — never a complaint.
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
      /\bif\s+cleaning\b/,
      /\bonce\s+cleaning\b/,
      /\bafter\s+(?:the\s+)?cleaning\s+team\b/,
      /\bso\s+(?:that\s+)?(?:you|the\s+team|cleaners?).{0,40}\bcleaning\b/,
      /\bin\s+case\s+you\s+want.{0,40}\bcleaning\b/,
      /\bwant\s+to\s+start\s+(?:the\s+)?cleaning\b/,
      /\bprepare\s+(?:the\s+)?(?:unit|place|apartment).{0,30}\bcleaning\b/,
    ];
  }

  /**
   * True when "cleaning" appears only in non-complaint / logistics contexts.
   */
  isLogisticsOnlyCleaningMention(text = '') {
    const t = (text || '').toLowerCase();
    if (!/\bcleaning\b/.test(t)) return false;
    const hasLogistics = this.nonComplaintCleaningPatterns.some((re) => re.test(t));
    if (!hasLogistics) return false;
    const hasStrong = this.strongComplaintPatterns.some((p) => t.includes(p));
    return !hasStrong;
  }

  // Alias used internally / older name
  _isNonComplaintCleaningMention(text = '') {
    return this.isLogisticsOnlyCleaningMention(text);
  }

  async execute(input, context = {}) {
    const message = typeof input === 'string' ? input : input?.message;

    if (!message || typeof message !== 'string') {
      return { detected: false, strength: null, blocksAutoReply: false };
    }

    const text = message.toLowerCase();

    // Isabella dirty-linen disposition ("where put the dirty ones?") is CHECKOUT policy —
    // not a cleaning complaint. Bare "dirty" must not escalate / wipe auto-reply.
    if (looksLikeDirtyLinenDispositionAsk(message)) {
      return {
        detected: false,
        strength: null,
        blocksAutoReply: false,
        logisticsOnly: false,
        matchedPhrase: null,
        reason: 'dirty_linen_disposition_not_complaint',
      };
    }

    // Logistics-only mentions (Olivia) — hard no-detect.
    if (this.isLogisticsOnlyCleaningMention(text)) {
      return {
        detected: false,
        strength: null,
        blocksAutoReply: false,
        logisticsOnly: true,
        matchedPhrase: null,
        reason: 'logistics_only_cleaning_mention',
      };
    }

    // Prefer specific strong complaint phrases (never bare "cleaning" alone).
    let matched = this.strongComplaintPatterns.find((pattern) => text.includes(pattern));
    let strength = matched ? 'strong' : null;

    // Weak: bare "cleaning" near complaint-ish words, only if NOT logistics.
    if (!matched && /\bcleaning\b/.test(text)) {
      const complaintyCleaning =
        /\b(?:poor|bad|terrible|awful|issue|problem|complaint|dirty|not|never|wasn't|wasnt|didn'?t|was not)\b.{0,40}\bcleaning\b/.test(text) ||
        /\bcleaning\b.{0,40}\b(?:issue|problem|poor|bad|terrible|awful|dirty|not done|never done|incomplete)\b/.test(text) ||
        /\b(?:the\s+)?cleaning\s+(?:was|is)\s+(?:poor|bad|terrible|awful|incomplete|not)\b/.test(text);
      if (complaintyCleaning) {
        matched = 'cleaning';
        // Bare "cleaning" is always weak — alert ok, never wipe a good draft alone.
        strength = 'weak';
      }
    }

    if (!matched) {
      return { detected: false, strength: null, blocksAutoReply: false };
    }

    // Strong phrases that are housekeeping setup (Amy) still block-or-not is decided by agent
    // policies (post-stay FYI allows reply). blocksAutoReply here = tool recommendation only.
    const blocksAutoReply = strength === 'strong';

    console.log(
      '[CleaningIssueTool] Cleaning complaint detected. Matched phrase:',
      matched,
      'strength:',
      strength,
      'blocksAutoReply:',
      blocksAutoReply
    );

    const matchIndex = text.indexOf(matched);
    const start = Math.max(0, matchIndex - 80);
    const end = Math.min(text.length, matchIndex + matched.length + 120);
    const contextSnippet = message.substring(start, end).trim();

    return {
      detected: true,
      type: 'cleaning',
      matchedPhrase: matched,
      strength,
      blocksAutoReply,
      summary: `Guest mentioned a cleaning issue related to "${matched}" (${strength}).`,
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
