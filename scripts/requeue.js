import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import 'dotenv/config';

const sqsClient = new SQSClient({ region: 'us-east-1' });

const queueUrl = process.env.SQS_QUEUE_URL;
if (!queueUrl) {
  console.error('ERROR: SQS_QUEUE_URL environment variable is required');
  process.exit(1);
}

// Exact original SQS message payload for the missed checkout-time query
// (from production miss: "Sounds great! Thank you! And what is the latest time we are able to check out Monday?")
const originalMessage = {
  guestMessage: "Sounds great! Thank you! And what is the latest time we are able to check out Monday?",
  context: {
    guestName: "Cassidy",
    checkIn: "2026-08-10",
    checkOut: "2026-08-11",
    listingId: "114663c5-0709-4eff-a868-fa9ebd6ed42d",
    propertyName: "Sunny Apt 2",
    bookingTimestamp: "2026-08-01T10:00:00Z",
    conversationHistory: []
  }
};

async function requeueMessage() {
  try {
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(originalMessage),
      MessageAttributes: {
        'requeue-reason': {
          DataType: 'String',
          StringValue: 'checkout-monday-miss-fix'
        }
      }
    });

    const result = await sqsClient.send(command);
    console.log('✅ Message re-queued successfully.');
    console.log('MessageId:', result.MessageId);
    console.log('QueueUrl:', queueUrl);
    console.log('The message is now visible in the queue and will be processed by the auto-reply system.');
  } catch (err) {
    console.error('❌ Failed to requeue message:', err.message || err);
    process.exit(1);
  }
}

requeueMessage();
