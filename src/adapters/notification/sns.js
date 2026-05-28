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

    if (!this.topicArn) {
      throw new Error('SNS topic ARN is required for SnsNotificationAdapter (set SNS_TOPIC_ARN or pass topicArn)');
    }

    this._sns = new SNSClient({ region: this.region });
  }

  async notifyEscalation({ decision, guestMessage, context, timestamp = new Date() }) {
    const guestName = context.guestName || 'Guest';
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
    const subject = `[CLEANING ALERT] ${res.guestName || 'Guest'} - ${res.propertyName || 'Property'}`;

    const message = [
      `CLEANING ISSUE DETECTED`,
      `Time: ${timestamp.toISOString()}`,
      '',
      `Guest: ${res.guestName || 'Unknown'}`,
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
}
