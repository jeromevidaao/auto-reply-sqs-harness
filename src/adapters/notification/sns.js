/**
 * SnsNotificationAdapter
 *
 * Production-style escalation using AWS SNS (same mechanism as the original auto-reply-sqs Lambda).
 * Publishes a message to the configured SNS topic, which can trigger email (or other) notifications.
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

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

  async notifyEscalation({ decision, guestMessage, context, timestamp = new Date() }) {
    const guestName = context.guestDisplayName || context.guestName || 'Guest';
    const property = context.propertyName || context.listingId || 'Unknown property';
    const dates = (context.checkIn && context.checkOut)
      ? `${context.checkIn} → ${context.checkOut}`
      : '';

    // Build direct Airbnb link if possible
    let airbnbLink = '';
    if (context.airbnb_message_url) {
      airbnbLink = context.airbnb_message_url;
    } else if (context.airbnb_conversation_id) {
      airbnbLink = `https://www.airbnb.com/hosting/messages/${context.airbnb_conversation_id}`;
    }

    const subject = `[Airbnb] Manual reply needed from ${guestName} - ${property}`;

    const messageLines = [
      `Guest: ${guestName}`,
      `Property: ${property}`,
      dates ? `Dates: ${dates}` : '',
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

    messageLines.push('Please review and reply manually.');

    const message = messageLines.join('\n');

    try {
      const command = new PublishCommand({
        TopicArn: this.topicArn,
        Subject: subject,
        Message: message,
      });

      const result = await this._sns.send(command);
      console.log(`✅ Escalation published to SNS (MessageId: ${result.MessageId})`);
      console.log('📤 ACTUAL ESCALATION MESSAGE SENT TO CLOUDWATCH/SNS:');
      console.log(message);
      return {
        escalated: true,
        channel: 'sns',
        messageId: result.MessageId,
        topicArn: this.topicArn,
      };
    } catch (err) {
      console.error('❌ Failed to publish escalation to SNS:', err.message);
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
  async notifyUrgentAccessIssue({ guestMessage, context, timestamp = new Date() }) {
    const guestName = context.guestDisplayName || context.guestName || 'Guest';
    const property = context.propertyName || context.listingId || 'Unknown property';
    const dates = (context.checkIn && context.checkOut)
      ? ` (${context.checkIn} → ${context.checkOut})`
      : '';

    // Build direct Airbnb link
    let airbnbLink = '';
    if (context.airbnb_message_url) {
      airbnbLink = context.airbnb_message_url;
    } else if (context.airbnb_conversation_id) {
      airbnbLink = `https://www.airbnb.com/hosting/messages/${context.airbnb_conversation_id}`;
    }

    const message = [
      `🚨 URGENT - GUEST CANNOT GET IN`,
      '',
      `Guest: ${guestName}${dates}`,
      `Property: ${property}`,
      '',
      `Message: ${guestMessage}`,
      '',
      airbnbLink ? `🔗 Direct link: ${airbnbLink}` : '',
      '',
      'Please assist the guest immediately.',
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
