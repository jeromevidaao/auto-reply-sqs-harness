/**
 * SnsNotificationAdapter
 *
 * Escalation (manual reply needed): Android FCM to cleaningbutton app (primary).
 * Full agent trace always logged to CloudWatch; SNS email topic is fallback only
 * if FCM is unavailable (no tokens / misconfigured).
 *
 * Cleaning issues still use SNS email topic. Urgent access still uses SNS SMS/topic.
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import {
  notifyOwnerAndroid,
  buildEscalationFcmContent,
  clip,
} from './fcm.js';

export class SnsNotificationAdapter {
  constructor(options = {}) {
    this.name = 'sns';
    this.region = options.region || 'us-east-1';
    this.topicArn = options.topicArn || process.env.SNS_TOPIC_ARN || process.env.ESCALATION_SNS_TOPIC_ARN;

    // Urgent access can be configured via a dedicated SNS topic (recommended for multiple recipients)
    // or via direct phone number(s)
    this.urgentAccessTopicArn = options.urgentAccessTopicArn || process.env.URGENT_ACCESS_SNS_TOPIC_ARN;
    this.urgentAccessPhone = options.urgentAccessPhone || process.env.URGENT_ACCESS_PHONE_NUMBER;

    this._sns = new SNSClient({ region: this.region });
  }

  /**
   * Build the full diagnostic escalation text (CloudWatch + SNS fallback only).
   * Too large for FCM — do not send this as push body.
   */
  _buildEscalationDiagnosticMessage({ decision, guestMessage, context, timestamp = new Date() }) {
    const guestName = context.guestDisplayName || context.guestName || 'Guest';
    const property = context.propertyName || context.listingId || 'Unknown property';
    const dates = (context.checkIn && context.checkOut)
      ? `${context.checkIn} → ${context.checkOut}`
      : '';

    const reservationId =
      context.reservationId ||
      context.reservation_id ||
      context.reservation?.id ||
      context.reservation?.reservation_id ||
      'N/A';
    const conversationId =
      context.conversation_id ||
      context.airbnb_conversation_id ||
      context.conversationId ||
      'N/A';

    let airbnbLink = '';
    if (context.airbnb_message_url) {
      airbnbLink = context.airbnb_message_url;
    } else if (context.conversation_id) {
      airbnbLink = `https://www.airbnb.com/hosting/messages/${context.conversation_id}`;
    } else if (context.airbnb_conversation_id) {
      airbnbLink = `https://www.airbnb.com/hosting/messages/${context.airbnb_conversation_id}`;
    }

    const subject = `[Airbnb] Manual reply needed from ${guestName} - ${property}`;

    const messageLines = [
      `Time: ${timestamp.toISOString()}`,
      `Guest: ${guestName}`,
      `Property: ${property}`,
      dates ? `Dates: ${dates}` : '',
      `Reservation ID: ${reservationId}`,
      `Conversation ID: ${conversationId}`,
      '',
      'Reason: Agent decided not to auto-reply.',
      `Category: ${decision.typeOfMessageReceived}`,
      `Confidence: ${decision.confidence ?? 'n/a'}`,
      '',
      'Guest message:',
      '---',
      guestMessage,
      '---',
      '',
    ];

    if (airbnbLink) {
      messageLines.push(`🔗 Direct Airbnb thread: ${airbnbLink}`);
      messageLines.push('');
    }

    const proposed = (decision && typeof decision.proposedResponse === 'string')
      ? decision.proposedResponse
      : 'none';
    messageLines.push('RESPONSE THAT WAS NOT SENT:');
    messageLines.push('```');
    messageLines.push(proposed);
    messageLines.push('```');
    messageLines.push('');

    messageLines.push('=== FULL AGENT TRACE / REASONING (how the agent reached "no auto-reply") ===');
    messageLines.push('');

    const coreDecision = {
      typeOfMessageReceived: decision?.typeOfMessageReceived,
      shouldReply: decision?.shouldReply,
      confidence: decision?.confidence,
      escalated: decision?.escalated,
      suppressedDueToRecentHost: decision?.suppressedDueToRecentHost || false,
      forceCancellationEscalation: decision?.forceCancellationEscalation || context?.forceCancellationEscalation || false,
      inquirySendFailed: decision?.inquirySendFailed || false,
      judgeForcedReject: !!(decision?.conversationJudge && decision.conversationJudge.verdict === 'REJECT'),
    };
    messageLines.push('Core decision:');
    messageLines.push(JSON.stringify(coreDecision, null, 2));
    messageLines.push('');

    if (decision?.reflection) {
      messageLines.push('Reflection:');
      messageLines.push(JSON.stringify(decision.reflection, null, 2));
      if (decision.reflectionNotes) {
        messageLines.push('Reflection notes: ' + decision.reflectionNotes);
      }
      messageLines.push('');
    } else {
      messageLines.push('Reflection: (not run or not present on this decision object)');
      messageLines.push('');
    }

    if (decision?.conversationJudge) {
      messageLines.push('Conversation Judge:');
      messageLines.push(JSON.stringify(decision.conversationJudge, null, 2));
      if (decision.judgeNotes) {
        messageLines.push('Judge notes: ' + decision.judgeNotes);
      }
      messageLines.push('');
    } else {
      messageLines.push('Conversation Judge: (not run or not present)');
      messageLines.push('');
    }

    const et = decision?.earlyTraces || context?.conversationTraces || context?.earlyTraces || null;
    if (et) {
      const traceSummary = {
        hasRecentHostMessage: et.hasRecentHostMessage || et.conversationTraces?.hasRecentHostMessage,
        duplicateRisk: et.duplicateRisk || et.conversationTraces?.duplicateRisk,
        earlyUnitReadyOffered: et.earlyUnitReadyOffered || et.conversationTraces?.earlyUnitReadyOffered,
        historyFetchFailed: et.historyFetchFailed || et.conversationTraces?.historyFetchFailed,
        historySource: et.historySource || et.conversationTraces?.historySource,
        recentMessageCount: et.recentMessageCount || et.conversationTraces?.recentMessageCount,
        preApprovalDetected: et.preApprovalDetected || et.conversationTraces?.preApprovalDetected,
        repeatedInstructionRisk: et.repeatedInstructionRisk || et.conversationTraces?.repeatedInstructionRisk,
        recentHostGreeting: et.recentHostGreeting || et.conversationTraces?.recentHostGreeting,
      };
      messageLines.push('Early traces / conversation safety signals:');
      messageLines.push(JSON.stringify(traceSummary, null, 2));
      messageLines.push('');
    } else {
      messageLines.push('Early traces: (none captured on this path)');
      messageLines.push('');
    }

    if (decision?.rawModelOutput) {
      const raw = String(decision.rawModelOutput);
      messageLines.push('First-pass raw model output (truncated):');
      messageLines.push(raw.length > 1800 ? raw.slice(0, 1800) + '…[truncated]' : raw);
      messageLines.push('');
    }

    if (decision?.notes) {
      messageLines.push('Decision notes: ' + decision.notes);
      messageLines.push('');
    }

    messageLines.push('Please review and reply manually.');
    messageLines.push('');
    messageLines.push('(Full CloudWatch logs for this request ID contain the complete enriched context, RAW EVENT, and every intermediate trace.)');

    return { subject, message: messageLines.join('\n') };
  }

  async notifyEscalation({ decision, guestMessage, context, timestamp = new Date() }) {
    const { subject, message } = this._buildEscalationDiagnosticMessage({
      decision,
      guestMessage,
      context,
      timestamp,
    });

    // Always log full diagnostics to CloudWatch (email used to carry this).
    console.log('📤 ESCALATION DIAGNOSTIC (CloudWatch):');
    console.log(message);

    // Primary: Android push (same owner_alerts channel as cleaning / battery).
    const fcmContent = buildEscalationFcmContent({ decision, guestMessage, context });
    // Include a short unsent-reply preview when present (fits tray BigText).
    const proposed = (decision && typeof decision.proposedResponse === 'string')
      ? decision.proposedResponse
      : '';
    if (proposed && proposed !== 'none') {
      fcmContent.body = clip(
        `${fcmContent.body}\n\nUnsent draft:\n${clip(proposed, 220)}`,
        900
      );
    }

    try {
      const fcmResult = await notifyOwnerAndroid(fcmContent);
      if (fcmResult.ok) {
        console.log(
          `✅ Escalation sent via Android FCM (success=${fcmResult.successCount} fail=${fcmResult.failureCount})`
        );
        return {
          escalated: true,
          channel: 'fcm',
          successCount: fcmResult.successCount,
          failureCount: fcmResult.failureCount,
        };
      }
      console.warn(
        `[Escalation] FCM unavailable (${fcmResult.reason || 'unknown'}); falling back to SNS email topic`
      );
    } catch (fcmErr) {
      console.warn('[Escalation] FCM failed; falling back to SNS email topic:', fcmErr.message);
    }

    // Fallback: SNS topic → email (legacy path) so escalations are never silent.
    if (!this.topicArn) {
      console.error('❌ Escalation: FCM failed and SNS_TOPIC_ARN is not set');
      throw new Error('Escalation notify failed: FCM unavailable and no SNS topic configured');
    }

    try {
      const command = new PublishCommand({
        TopicArn: this.topicArn,
        Subject: subject,
        Message: message,
      });

      const result = await this._sns.send(command);
      console.log(`✅ Escalation published to SNS fallback (MessageId: ${result.MessageId})`);
      return {
        escalated: true,
        channel: 'sns-fallback',
        messageId: result.MessageId,
        topicArn: this.topicArn,
      };
    } catch (err) {
      console.error('❌ Failed to publish escalation to SNS fallback:', err.message);
      throw err;
    }
  }

  /**
   * Dedicated cleaning issue notification via SNS.
   * For now it publishes to the same topic with a special subject.
   * Later this can be pointed to a dedicated SNS topic or email list for the cleaning crew.
   */
  async notifyCleaningIssue({ cleaningIssue, guestMessage, context, timestamp = new Date() }) {
    if (!this._sns) {
      await this._getSnsClient();
    }

    const res = cleaningIssue.reservation || context || {};
    const guestName = res.guestDisplayName || res.guestName || context?.guestDisplayName || context?.guestName || 'Guest';
    const subject = `[CLEANING ALERT] ${guestName} - ${res.propertyName || 'Property'}`;

    const message = [
      `CLEANING ISSUE DETECTED`,
      `Time: ${timestamp.toISOString()}`,
      '',
      `Guest: ${guestName}`,
      `Reservation: ${res.id || res.reservationId || 'N/A'}`,
      `Property: ${res.propertyName || 'N/A'}`,
      `Check-in:  ${res.checkIn || 'N/A'}`,
      `Check-out: ${res.checkOut || 'N/A'}`,
      '',
      `Issue: ${cleaningIssue.summary || cleaningIssue.matchedPhrase}`,
      '',
      `Full message:`,
      guestMessage,
      '',
      `Please forward to the cleaning team.`,
    ].join('\n');

    const command = new PublishCommand({
      TopicArn: this.topicArn,
      Subject: subject,
      Message: message,
    });

    try {
      const result = await this._sns.send(command);
      console.log(`✅ Cleaning issue published to SNS (MessageId: ${result.MessageId})`);
      console.log('📤 ACTUAL CLEANING ALERT SENT TO CLOUDWATCH/SNS:');
      console.log(message);
      return {
        notified: true,
        type: 'cleaning_issue',
        channel: 'sns',
        messageId: result.MessageId,
      };
    } catch (err) {
      console.error('❌ Failed to publish cleaning issue to SNS:', err.message);
      throw err;
    }
  }

  /**
   * Urgent access issue notification.
   * Used for situations where a guest cannot get into the property (lockbox, door code, wrong entrance, etc.).
   * This is considered time-sensitive.
   *
   * Supports two modes:
   * 1. Dedicated SNS topic (recommended when notifying multiple people, e.g. Jerome + Ruby)
   * 2. Direct phone number(s) via URGENT_ACCESS_PHONE_NUMBER (comma-separated supported)
   */
  async notifyUrgentAccessIssue({ guestMessage, context, timestamp = new Date(), category, proposedResponse } = {}) {
    const guestName = context.guestDisplayName || context.guestName || 'Guest';
    const property = context.propertyName || context.listingId || 'Unknown property';
    const dates = (context.checkIn && context.checkOut)
      ? ` (${context.checkIn} → ${context.checkOut})`
      : '';

    // Build direct Airbnb link (prefer real conversation_id from Hospitable)
    let airbnbLink = '';
    if (context.airbnb_message_url) {
      airbnbLink = context.airbnb_message_url;
    } else if (context.conversation_id) {
      airbnbLink = `https://www.airbnb.com/hosting/messages/${context.conversation_id}`;
    } else if (context.airbnb_conversation_id) {
      airbnbLink = `https://www.airbnb.com/hosting/messages/${context.airbnb_conversation_id}`;
    }

    const isApt2StreetLockout = category === 'APT2_STREET_DOOR_LOCKOUT';
    const headline = isApt2StreetLockout
      ? '🚨 URGENT - APT 2 STREET LOCKOUT (bolted parking door)'
      : '🚨 URGENT - GUEST CANNOT GET IN';
    const guidance = isApt2StreetLockout
      ? 'Apt 2: guest likely bolted parking door + exited street. Auto-reply should cover top lockbox {{APT2_STREET_LOCKBOX_CODE}} + pin. Call/text guest if still stuck.'
      : 'Please assist the guest immediately.';

    const message = [
      headline,
      '',
      `Guest: ${guestName}${dates}`,
      `Property: ${property}`,
      category ? `Category: ${category}` : '',
      '',
      `Message: ${guestMessage}`,
      '',
      proposedResponse && proposedResponse !== 'none'
        ? `Auto-reply sent/proposed:\n${String(proposedResponse).slice(0, 500)}`
        : '',
      '',
      airbnbLink ? `🔗 Direct link: ${airbnbLink}` : '',
      '',
      guidance,
    ].filter(Boolean).join('\n');

    // Preferred: Publish to a dedicated SNS topic (supports multiple SMS subscriptions)
    if (this.urgentAccessTopicArn) {
      try {
        const command = new PublishCommand({
          TopicArn: this.urgentAccessTopicArn,
          Message: message,
          Subject: `URGENT: Guest cannot get in - ${property}`,
        });

        const result = await this._sns.send(command);
        console.log(`✅ Urgent access notification published to topic ${this.urgentAccessTopicArn} (MessageId: ${result.MessageId})`);
        return {
          notified: true,
          type: 'urgent_access',
          channel: 'sns-topic',
          topicArn: this.urgentAccessTopicArn,
          messageId: result.MessageId,
        };
      } catch (err) {
        console.error('❌ Failed to publish urgent access to SNS topic:', err.message);
        throw err;
      }
    }

    // Fallback: Direct SMS to one or more phone numbers
    const phoneNumbersRaw = this.urgentAccessPhone;
    if (!phoneNumbersRaw) {
      console.warn('[SNS] Neither URGENT_ACCESS_SNS_TOPIC_ARN nor URGENT_ACCESS_PHONE_NUMBER configured. Cannot send urgent access alert.');
      return { notified: false, reason: 'no_urgent_access_config' };
    }

    const phoneNumbers = phoneNumbersRaw
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => p.startsWith('+') ? p : `+1${p.replace(/\D/g, '')}`);

    const results = [];

    for (const phone of phoneNumbers) {
      try {
        const command = new PublishCommand({
          PhoneNumber: phone,
          Message: message,
          MessageAttributes: {
            'AWS.SNS.SMS.SMSType': {
              DataType: 'String',
              StringValue: 'Transactional'
            }
          }
        });

        const result = await this._sns.send(command);
        console.log(`✅ Urgent access SMS sent to ${phone} (MessageId: ${result.MessageId})`);
        results.push({ phone, messageId: result.MessageId });
      } catch (err) {
        console.error(`❌ Failed to send urgent access SMS to ${phone}:`, err.message);
        // Continue trying other numbers
      }
    }

    return {
      notified: results.length > 0,
      type: 'urgent_access',
      channel: 'sms-direct',
      results,
    };
  }
}
