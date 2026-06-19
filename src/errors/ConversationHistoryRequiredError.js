/**
 * Thrown when live conversation history is required but could not be fetched.
 * Causes a hard Lambda failure so SQS retries / DLQ and CloudWatch alarms fire.
 */
export class ConversationHistoryRequiredError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConversationHistoryRequiredError';
    this.conversationId = details.conversationId ?? null;
    this.reservationId = details.reservationId ?? null;
    this.historySource = details.historySource ?? null;
    this.originalError = details.originalError ?? null;
  }
}