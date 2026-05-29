import { BaseTool } from '../BaseTool.js';

/**
 * CancellationTool
 *
 * Handles cancellation, refund questions, notifications, and exception requests.
 * This is one of the highest-risk areas — accuracy and anti-contradiction are critical.
 */
export class CancellationTool extends BaseTool {
  constructor() {
    super({
      name: 'handle_cancellation',
      description: 'Evaluates cancellation/refund requests using strict timing rules from production. Detects when to escalate to avoid contradicting prior host statements. Returns structured decision + recommended response guidance.',
    });
  }

  async execute(input, context = {}) {
    const message = (typeof input === 'string' ? input : input?.message || '').toLowerCase();
    const conversationHistory = context.conversationHistory || [];

    const bookingTimestamp = context.bookingTimestamp || context.bookingDate;
    const checkIn = context.checkIn;

    const isPolicyQuestion = /refund|cancel.*policy|money back|what if i cancel/i.test(message);
    const isNotification = /i (have to|need to|am going to) cancel|won't be able to make it|cannot make it/i.test(message);
    const isExceptionRequest = /illness|emergency|divorce|separation|husband|wife|sick|personal circumstances|cannot come/i.test(message);

    const priorHostStatements = this._findPriorCancellationStatements(conversationHistory);
    const hasPriorCommitment = priorHostStatements.length > 0;

    let refundType = 'unknown';
    let explanation = '';
    let recommendedAction = 'escalate';

    if (isExceptionRequest) {
      explanation = 'Empathetic but firm: we do not make exceptions due to fixed costs.';
      recommendedAction = 'escalate';
    } else if (isNotification || isPolicyQuestion) {
      const refundCalc = this._calculateRefund(bookingTimestamp, checkIn);

      refundType = refundCalc.type;
      explanation = refundCalc.explanation;

      if (hasPriorCommitment) {
        recommendedAction = 'escalate'; // avoid contradicting host
      } else {
        recommendedAction = 'respond_with_policy';
      }
    }

    console.log('[CancellationTool] Analysis complete. Type:', isExceptionRequest ? 'EXCEPTION' : isNotification ? 'NOTIFICATION' : 'POLICY_QUESTION', 'Needs escalation:', hasPriorCommitment || isExceptionRequest);

    return {
      detected: true,
      category: isExceptionRequest ? 'CANCELLATION_POLICY_EXCEPTION' : isNotification ? 'CANCELLATION_NOTIFICATION' : 'CANCELLATION_POLICY',
      refundType,
      explanation,
      hasPriorHostCommitment: hasPriorCommitment,
      priorStatements: priorHostStatements,
      recommendedAction,
      needsEscalation: hasPriorCommitment || isExceptionRequest,
      // Always surface the official live Airbnb policy link
      officialPolicyUrl: 'https://www.airbnb.com/help/article/475',
      policyNote: 'Our cancellation policy is strict. Always direct guests to review the current official policy at the link above. Do not make exceptions or soften the policy.',
    };
  }

  _calculateRefund(bookingTimestamp, checkIn) {
    if (!bookingTimestamp || !checkIn) {
      return {
        type: 'unknown',
        explanation: 'Unable to calculate without booking time and check-in date. Please escalate.'
      };
    }

    const bookingDate = new Date(bookingTimestamp);
    const checkInDate = new Date(checkIn);
    const now = new Date();

    const hoursSinceBooking = (now - bookingDate) / (1000 * 60 * 60);
    const daysUntilCheckIn = Math.ceil((checkInDate - now) / (1000 * 60 * 60 * 24));

    if (hoursSinceBooking <= 24 && daysUntilCheckIn >= 14) {
      return {
        type: 'full',
        explanation: 'Full refund (including taxes) because you booked within 24 hours AND your check-in is more than 14 days away.'
      };
    } else if (daysUntilCheckIn >= 7) {
      return {
        type: 'fifty_percent',
        explanation: '50% refund (including taxes) because you booked more than 24 hours ago, but your check-in is still 7+ days away.'
      };
    } else {
      return {
        type: 'cleaning_fee_only',
        explanation: 'Only the cleaning fee + pro-rated taxes because your check-in is less than 7 days away.'
      };
    }
  }

  _findPriorCancellationStatements(conversationHistory) {
    // Very simple heuristic for now — production version would be more sophisticated
    return conversationHistory
      .filter(m => (m.sender_type === 'host' || m.sender?.type === 'host') &&
                   /refund|cancel|alteration|policy/i.test(m.body || ''))
      .map(m => m.body?.substring(0, 300));
  }
}
