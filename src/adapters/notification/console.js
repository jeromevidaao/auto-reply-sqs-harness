/**
 * ConsoleEscalationAdapter
 *
 * Default notification adapter for local development.
 * When the agent decides not to auto-reply, this prints a very clear
 * "ESCALATION REQUIRED - Manual reply needed" block.
 *
 * This is the local equivalent of the SNS → email behavior in the original Lambda.
 */

export class ConsoleEscalationAdapter {
  constructor(options = {}) {
    this.name = 'console';
  }

  /**
   * Called when the agent decides a message should NOT be auto-replied to.
   */
  async notifyEscalation({ decision, guestMessage, context, timestamp = new Date() }) {
    const lines = [];

    lines.push('\n' + '='.repeat(80));
    lines.push('🚨  ESCALATION REQUIRED — MANUAL REPLY NEEDED');
    lines.push('='.repeat(80));
    lines.push(`Time: ${timestamp.toISOString()}`);
    lines.push(`Category: ${decision.typeOfMessageReceived}`);
    lines.push(`Confidence: ${decision.confidence ?? 'n/a'}`);
    lines.push('');

    const guestName = context.guestDisplayName || context.guestName || 'Guest';
    if (guestName) {
      lines.push(`Guest: ${guestName}`);
    }
    if (context.checkIn && context.checkOut) {
      lines.push(`Stay: ${context.checkIn} → ${context.checkOut}`);
    }
    if (context.propertyName) {
      lines.push(`Property: ${context.propertyName}`);
    }
    if (context.listingId) {
      lines.push(`Listing ID: ${context.listingId}`);
    }

    lines.push('');
    lines.push('Guest message:');
    lines.push('---');
    lines.push(guestMessage);
    lines.push('---');
    lines.push('');

    if (decision.notes) {
      lines.push(`Notes from agent: ${decision.notes}`);
      lines.push('');
    }

    // Direct Airbnb link (very useful for quick access)
    const airbnbLink =
      context.airbnb_message_url ||
      (context.airbnb_conversation_id
        ? `https://www.airbnb.com/hosting/messages/${context.airbnb_conversation_id}`
        : null);

    if (airbnbLink) {
      lines.push(`🔗 Direct Airbnb thread: ${airbnbLink}`);
      lines.push('');
    }

    lines.push('Action: No auto-reply was sent.');
    lines.push('Please review and reply manually if appropriate.');
    lines.push('='.repeat(80) + '\n');

    console.error(lines.join('\n'));

    // Also return the escalation payload in case the caller wants to do something else with it
    return {
      escalated: true,
      channel: 'console',
      payload: {
        guestMessage,
        context,
        decision,
        timestamp: timestamp.toISOString(),
      }
    };
  }

  /**
   * Dedicated notification for cleaning issues found in guest feedback.
   * This sends a separate, high-visibility alert (currently console, later email/SNS).
   */
  async notifyCleaningIssue({ cleaningIssue, guestMessage, context, timestamp = new Date() }) {
    const lines = [];

    const res = cleaningIssue.reservation || context || {};

    // Format dates nicely with day of week
    const formatDateWithDay = (dateStr) => {
      if (!dateStr) return 'N/A';
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    };

    lines.push('\n' + '#'.repeat(80));
    lines.push('🧹  CLEANING ISSUE ALERT — ACTION REQUIRED FOR CLEANING CREW');
    lines.push('#'.repeat(80));
    lines.push(`Detected at: ${timestamp.toISOString()}`);
    lines.push('');

    const guestName = res.guestDisplayName || res.guestName || context?.guestDisplayName || context?.guestName || 'Guest';
    if (guestName) {
      lines.push(`Guest: ${guestName}`);
    }
    if (res.id || res.reservationId) {
      lines.push(`Reservation ID: ${res.id || res.reservationId}`);
    }
    if (res.propertyName) {
      lines.push(`Property: ${res.propertyName}`);
    }
    if (res.listingId) {
      lines.push(`Listing ID: ${res.listingId}`);
    }

    lines.push('');
    lines.push(`Check-in : ${formatDateWithDay(res.checkIn)}`);
    lines.push(`Check-out: ${formatDateWithDay(res.checkOut)}`);
    lines.push('');

    lines.push('Specific cleaning issue mentioned:');
    lines.push(`→ ${cleaningIssue.summary || cleaningIssue.matchedPhrase || 'Cleaning complaint detected'}`);
    lines.push('');

    if (cleaningIssue.contextSnippet) {
      lines.push('Context from guest message:');
      lines.push('---');
      lines.push(cleaningIssue.contextSnippet);
      lines.push('---');
      lines.push('');
    }

    lines.push('Full guest message:');
    lines.push('---');
    lines.push(guestMessage);
    lines.push('---');
    lines.push('');

    lines.push('Action: Please review and forward to the cleaning team.');
    lines.push('Recipient (for now): jerome.ans@gmail.com');
    lines.push('#'.repeat(80) + '\n');

    console.error(lines.join('\n'));

    return {
      notified: true,
      type: 'cleaning_issue',
      channel: 'console',
      payload: {
        cleaningIssue,
        guestMessage,
        context,
        timestamp: timestamp.toISOString(),
      }
    };
  }
}
