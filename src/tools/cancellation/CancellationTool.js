import { BaseTool } from '../BaseTool.js';

/**
 * CancellationTool
 *
 * Handles cancellation, refund questions, notifications, and exception requests.
 * This is one of the highest-risk areas — accuracy and anti-contradiction are critical.
 *
 * Also detects when the Hospitable reservation is *already cancelled* so we never
 * offer policy links / "cancellation options" after the guest has already cancelled
 * (Julia medical early-departure incident).
 */
export class CancellationTool extends BaseTool {
  constructor() {
    super({
      name: 'handle_cancellation',
      description: 'Evaluates cancellation/refund requests using strict timing rules from production. Detects when to escalate to avoid contradicting prior host statements. When reservation is already cancelled, blocks policy links and option language. Returns structured decision + recommended response guidance.',
    });
  }

  /**
   * Extract reservation status category from context or a raw Hospitable reservation object.
   * Prefer reservation_status.current.category; fall back to legacy status string.
   */
  static extractReservationStatus(source = {}) {
    if (!source || typeof source !== 'object') return null;

    const fromNested =
      source.reservation_status?.current?.category ||
      source.reservation_status?.current?.status ||
      source.reservationStatus?.current?.category ||
      source.reservation?.reservation_status?.current?.category ||
      source.reservation?.status ||
      null;

    const direct =
      source.reservationStatus ||
      source.reservation_status_category ||
      source.status ||
      null;

    const raw = fromNested || direct;
    if (raw == null) return null;
    if (typeof raw === 'object') {
      return raw.category || raw.status || null;
    }
    return String(raw).trim() || null;
  }

  /** True when Hospitable reports the booking is already cancelled. */
  static isAlreadyCancelledStatus(status) {
    if (status == null || status === '') return false;
    const s = String(status).toLowerCase().trim();
    // category: cancelled; also tolerate US spelling and legacy strings
    return (
      s === 'cancelled' ||
      s === 'canceled' ||
      s === 'voided' ||
      s.includes('cancel')
    );
  }

  static isAlreadyCancelled(context = {}) {
    const status = CancellationTool.extractReservationStatus(context);
    return CancellationTool.isAlreadyCancelledStatus(status);
  }

  async execute(input, context = {}) {
    const message = (typeof input === 'string' ? input : input?.message || '').toLowerCase();
    const conversationHistory = context.conversationHistory || [];

    const bookingTimestamp = context.bookingTimestamp || context.bookingDate;
    const checkIn = context.checkIn;
    const reservationStatus = CancellationTool.extractReservationStatus(context);
    const alreadyCancelled = CancellationTool.isAlreadyCancelledStatus(reservationStatus);

    const isPolicyQuestion = /refund|cancel.*policy|money back|what if i cancel|cancellation options|cancel.*option/i.test(message);
    const isNotification = /i (have to|need to|am going to) cancel|won't be able to make it|cannot make it/i.test(message);
    const isExceptionRequest = /illness|emergency|divorce|separation|husband|wife|sick|personal circumstances|cannot come|medical/i.test(message);

    const priorHostStatements = this._findPriorCancellationStatements(conversationHistory);
    const hasPriorCommitment = priorHostStatements.length > 0;

    // === Already cancelled (Julia medical early-departure incident) ===
    // Guest already cancelled on the platform; do not offer policy page or "options".
    if (alreadyCancelled) {
      console.log(
        '[CancellationTool] Reservation already cancelled (status=' +
          reservationStatus +
          ') — skip policy link / cancellation options'
      );
      return {
        detected: true,
        alreadyCancelled: true,
        reservationStatus: reservationStatus || 'cancelled',
        category: 'CANCELLATION_NOTIFICATION',
        refundType: 'n/a_already_cancelled',
        explanation:
          'Hospitable reservation status is already cancelled. The guest does not need cancellation options or the Airbnb policy link — cancellation is already done.',
        hasPriorHostCommitment: hasPriorCommitment,
        priorStatements: priorHostStatements,
        recommendedAction: 'acknowledge_already_cancelled',
        needsEscalation: false,
        includePolicyLink: false,
        officialPolicyUrl: null,
        policyNote:
          'Do NOT include https://www.airbnb.com/help/article/475 or any cancellation options language. Empathize, acknowledge the reservation is already cancelled, wish them well.',
        suggestedResponseGuidance:
          'Empathize with the difficult situation. Explicitly or clearly acknowledge that the reservation is already cancelled so no further cancellation steps are needed. Do not discuss how to cancel, refund windows, or link the Airbnb policy page. Wish them well. If they specifically ask about refund timing for a completed cancel, stay general and prefer host review rather than inventing refund math.',
      };
    }

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

    console.log(
      '[CancellationTool] Analysis complete. Type:',
      isExceptionRequest ? 'EXCEPTION' : isNotification ? 'NOTIFICATION' : 'POLICY_QUESTION',
      'Needs escalation:',
      hasPriorCommitment || isExceptionRequest,
      'status:',
      reservationStatus || 'unknown'
    );

    return {
      detected: true,
      alreadyCancelled: false,
      reservationStatus: reservationStatus || null,
      category: isExceptionRequest
        ? 'CANCELLATION_POLICY_EXCEPTION'
        : isNotification
          ? 'CANCELLATION_NOTIFICATION'
          : 'CANCELLATION_POLICY',
      refundType,
      explanation,
      hasPriorHostCommitment: hasPriorCommitment,
      priorStatements: priorHostStatements,
      recommendedAction,
      needsEscalation: hasPriorCommitment || isExceptionRequest,
      includePolicyLink: true,
      // Always surface the official live Airbnb policy link (active reservations only)
      officialPolicyUrl: 'https://www.airbnb.com/help/article/475',
      policyNote:
        'Our cancellation policy is strict. Always direct guests to review the current official policy at the link above. Do not make exceptions or soften the policy.',
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
