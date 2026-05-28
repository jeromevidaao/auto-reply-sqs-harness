/**
 * SnsNotificationAdapter
 *
 * Production-style escalation using AWS SNS (same mechanism as the original auto-reply-sqs Lambda).
 * Publishes a message to the configured SNS topic, which can trigger email (or other) notifications.
 */

// Lazy import so the harness works without @aws-sdk/client-sns installed
// (only needed when you actually want SNS escalation)
let SNSClient, PublishCommand;
async function loadAwsSdk() {
  if (!SNSClient) {
    const awsSdk = await import('@aws-sdk/client-sns');
    SNSClient = awsSdk.SNSClient;
    PublishCommand = awsSdk.PublishCommand;
  }
}

export class SnsNotificationAdapter {
  constructor(options = {}) {
    this.name = 'sns';
    this.region = options.region || 'us-east-1';
    this.topicArn = options.topicArn || process.env.SNS_TOPIC_ARN || process.env.ESCALATION_SNS_TOPIC_ARN;

    if (!this.topicArn) {
      throw new Error('SNS topic ARN is required for SnsNotificationAdapter (set SNS_TOPIC_ARN or pass topicArn)');
    }

    this._sns = null; // lazy
  }

  async _getSnsClient() {
    if (!this._sns) {
      await loadAwsSdk();
      this._sns = new SNSClient({ region: this.region });
    }
    return this._sns;
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

    const command = new PublishCommand({
      TopicArn: this.topicArn,
      Subject: subject,
      Message: message,
    });

    try {
      const sns = await this._getSnsClient();
      const result = await sns.send(command);
      console.log(`✅ Escalation published to SNS (MessageId: ${result.MessageId})`);
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
}
