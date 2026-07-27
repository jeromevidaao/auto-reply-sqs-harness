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

    // IDs (user requirement: surface reservation id + conv id in all escalation outputs)
    const reservationId =
      context.reservationId || context.reservation_id || context.reservation?.id || 'N/A';
    const conversationId =
      context.conversation_id || context.airbnb_conversation_id || 'N/A';
    lines.push(`Reservation ID: ${reservationId}`);
    lines.push(`Conversation ID: ${conversationId}`);

    lines.push('');
    lines.push('Guest message:');
    lines.push('---');
    lines.push(guestMessage);
    lines.push('---');
    lines.push('');

    // The response the agent produced but did not send (critical for diagnosis)
    const proposed = (decision && typeof decision.proposedResponse === 'string') ? decision.proposedResponse : 'none';
    lines.push('RESPONSE THAT WAS NOT SENT:');
    lines.push('```');
    lines.push(proposed);
    lines.push('```');
    lines.push('');

    // Full trace section (matches the SNS email enrichment)
    lines.push('=== FULL AGENT TRACE / REASONING (how the agent reached "no auto-reply") ===');
    lines.push('');

    const coreDecision = {
      typeOfMessageReceived: decision?.typeOfMessageReceived,
      shouldReply: decision?.shouldReply,
      confidence: decision?.confidence,
      escalated: decision?.escalated,
      suppressedDueToRecentHost: decision?.suppressedDueToRecentHost || false,
      judgeForcedReject: !!(decision?.conversationJudge && decision.conversationJudge.verdict === 'REJECT'),
    };
    lines.push('Core decision:');
    lines.push(JSON.stringify(coreDecision, null, 2));
    lines.push('');

    if (decision?.reflection) {
      lines.push('Reflection:');
      lines.push(JSON.stringify(decision.reflection, null, 2));
      if (decision.reflectionNotes) lines.push('Reflection notes: ' + decision.reflectionNotes);
      lines.push('');
    }

    if (decision?.conversationJudge) {
      lines.push('Conversation Judge:');
      lines.push(JSON.stringify(decision.conversationJudge, null, 2));
      if (decision.judgeNotes) lines.push('Judge notes: ' + decision.judgeNotes);
      lines.push('');
    }

    const et = decision?.earlyTraces || context?.conversationTraces || null;
    if (et) {
      const traceSummary = {
        hasRecentHostMessage: et.hasRecentHostMessage || et.conversationTraces?.hasRecentHostMessage,
        duplicateRisk: et.duplicateRisk || et.conversationTraces?.duplicateRisk,
        earlyUnitReadyOffered: et.earlyUnitReadyOffered || et.conversationTraces?.earlyUnitReadyOffered,
        historyFetchFailed: et.historyFetchFailed || et.conversationTraces?.historyFetchFailed,
        historySource: et.historySource || et.conversationTraces?.historySource,
      };
      lines.push('Early traces / safety signals:');
      lines.push(JSON.stringify(traceSummary, null, 2));
      lines.push('');
    }

    if (decision?.rawModelOutput) {
      const raw = String(decision.rawModelOutput);
      lines.push('First-pass raw model output (truncated):');
      lines.push(raw.length > 1200 ? raw.slice(0, 1200) + '…[truncated]' : raw);
      lines.push('');
    }

    if (decision?.notes) {
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
    lines.push('Recipient: owner email from SSM /host/contacts-json (never hardcode)');
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

  /**
   * Local equivalent of SNS urgent-access SMS (lockout / door code / Apt 2 street lockout).
   */
  async notifyUrgentAccessIssue({ guestMessage, context, timestamp = new Date(), category, proposedResponse } = {}) {
    const guestName = context.guestDisplayName || context.guestName || 'Guest';
    const property = context.propertyName || context.listingId || 'Unknown property';
    const isApt2StreetLockout = category === 'APT2_STREET_DOOR_LOCKOUT';

    const lines = [];
    lines.push('\n' + '!'.repeat(80));
    lines.push(isApt2StreetLockout
      ? '🚨  URGENT ACCESS — APT 2 STREET LOCKOUT (bolted parking door)'
      : '🚨  URGENT ACCESS — GUEST CANNOT GET IN');
    lines.push('!'.repeat(80));
    lines.push(`Time: ${timestamp.toISOString()}`);
    lines.push(`Guest: ${guestName}`);
    lines.push(`Property: ${property}`);
    if (category) lines.push(`Category: ${category}`);
    lines.push('');
    lines.push('Guest message:');
    lines.push('---');
    lines.push(guestMessage);
    lines.push('---');
    if (proposedResponse && proposedResponse !== 'none') {
      lines.push('');
      lines.push('Auto-reply proposed/sent:');
      lines.push(String(proposedResponse).slice(0, 800));
    }
    lines.push('');
    lines.push(isApt2StreetLockout
      ? 'Action: SMS Jerome + Ruby (prod: URGENT_ACCESS_*). Street top lockbox {{APT2_STREET_LOCKBOX_CODE}} + pin.'
      : 'Action: SMS hosts immediately (prod: URGENT_ACCESS_SNS_TOPIC_ARN or URGENT_ACCESS_PHONE_NUMBER).');
    lines.push('!'.repeat(80) + '\n');

    console.error(lines.join('\n'));

    return {
      notified: true,
      type: 'urgent_access',
      channel: 'console',
      category: category || null,
    };
  }
}
