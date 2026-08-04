import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Re-queue a specific SQS message (by providing body or targeting known missed cases).
 * Used to reprocess the Roberto new-booking confirmation that was missed.
 */
export async function requeueMessage(queueUrl, messageBody) {
  if (!queueUrl) {
    throw new Error('queueUrl is required');
  }
  const body = typeof messageBody === 'string' ? messageBody : JSON.stringify(messageBody);
  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: body,
  });
  await sqs.send(command);
  console.log('[reprocess] Message re-queued to', queueUrl);
}

/**
 * Target the Roberto new-booking message for reprocessing.
 * Re-sends a payload that should trigger the hardened new-booking reply path.
 */
export async function reprocessRobertoMessage(queueUrl) {
  const robertoPayload = {
    // Reconstructs the missed guest message event for Roberto
    MessageId: 'roberto-new-booking-miss',
    Body: JSON.stringify({
      guestMessage: 'ok for a new booking',
      conversationId: 'roberto-conversation',
      listingId: 'roberto-listing',
      guest: { name: 'Roberto' },
      reservation: { status: 'confirmed', isNew: true },
      // minimal context that should have matched NEW_RESERVATION_WELCOME / new-booking intent
      type: 'guest_message_created',
    }),
  };
  await requeueMessage(queueUrl, robertoPayload.Body);
  console.log('[reprocess] Targeted Roberto new-booking message re-queued');
}

export default { requeueMessage, reprocessRobertoMessage };
