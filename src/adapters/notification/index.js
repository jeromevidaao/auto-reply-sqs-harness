import { ConsoleEscalationAdapter } from './console.js';
import { SnsNotificationAdapter } from './sns.js';

/**
 * Factory for notification/escalation adapters.
 *
 * - 'console' (or default in most cases) → very visible local output
 * - 'sns' → production adapter (Android FCM for manual-reply escalations; SNS for cleaning/urgent)
 * - 'auto' → uses production adapter if SNS_TOPIC_ARN is set (or always prefer sns in Lambda), else console
 */
export function createNotificationAdapter(type = 'auto') {
  // In Lambda we always want the production adapter so FCM escalations work even if SNS_TOPIC_ARN is removed later.
  const isLambda = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
  const hasSnsArn = !!(process.env.SNS_TOPIC_ARN || process.env.ESCALATION_SNS_TOPIC_ARN);

  if (type === 'sns') {
    return new SnsNotificationAdapter();
  }

  if (type === 'console') {
    return new ConsoleEscalationAdapter();
  }

  if (type === 'auto') {
    if (hasSnsArn || isLambda) {
      try {
        return new SnsNotificationAdapter();
      } catch (e) {
        console.warn('Production notification adapter failed to initialize, falling back to console:', e.message);
        return new ConsoleEscalationAdapter();
      }
    }
    return new ConsoleEscalationAdapter();
  }

  console.warn(`Unknown notification adapter type "${type}", falling back to console.`);
  return new ConsoleEscalationAdapter();
}
