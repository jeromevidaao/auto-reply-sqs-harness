import { ConsoleEscalationAdapter } from './console.js';
import { SnsNotificationAdapter } from './sns.js';

/**
 * Factory for notification/escalation adapters.
 *
 * - 'console' (or default in most cases) → very visible local output
 * - 'sns' → publishes to SNS (matches original production Lambda behavior)
 * - 'auto' → uses SNS if SNS_TOPIC_ARN or ESCALATION_SNS_TOPIC_ARN is set, otherwise console
 */
export function createNotificationAdapter(type = 'auto') {
  const hasSnsArn = !!(process.env.SNS_TOPIC_ARN || process.env.ESCALATION_SNS_TOPIC_ARN);

  if (type === 'sns') {
    return new SnsNotificationAdapter();
  }

  if (type === 'console') {
    return new ConsoleEscalationAdapter();
  }

  if (type === 'auto') {
    if (hasSnsArn) {
      try {
        return new SnsNotificationAdapter();
      } catch (e) {
        console.warn('SNS ARN detected but SNS adapter failed to initialize, falling back to console:', e.message);
        return new ConsoleEscalationAdapter();
      }
    }
    return new ConsoleEscalationAdapter();
  }

  console.warn(`Unknown notification adapter type "${type}", falling back to console.`);
  return new ConsoleEscalationAdapter();
}
