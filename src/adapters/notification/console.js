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

    if (context.guestName) {
      lines.push(`Guest: ${context.guestName}`);
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
}
