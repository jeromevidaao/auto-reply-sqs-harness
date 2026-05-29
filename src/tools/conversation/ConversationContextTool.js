import { BaseTool } from '../BaseTool.js';

/**
 * ConversationContextTool
 *
 * Provides rich pre-processing traces that were critical in the old production system:
 * - Pre-approval detection for inquiries (fast path)
 * - Recent host message check (anti-duplicate / race condition protection)
 *
 * These traces should be available early so the multipass system (main LLM + reflection + judge)
 * can make higher quality decisions.
 */
export class ConversationContextTool extends BaseTool {
  constructor({ hospitableClient = null } = {}) {
    super({
      name: 'get_conversation_context',
      description: 'Returns pre-approval status, recent host messages, and other safety traces for high-quality multipass decisions.',
    });
    this.hospitableClient = hospitableClient;
  }

  async execute(input, context = {}) {
    const reservationId = context.reservationId || context.airbnb_conversation_id;
    const inquiryId = context.inquiryId || (context.reservationId === null ? context.airbnb_conversation_id : null);
    const isInquiry = !context.reservationId && !!inquiryId;

    const result = {
      hasRecentHostMessage: false,
      preApprovalDetected: false,
      preApprovalMessage: null,
      traces: [],
    };

    // Recent host message check (10 minute window, important for pre-approval races)
    // In production this used Hospitable message history
    if (context.conversationHistory && context.conversationHistory.length > 0) {
      const recentHost = context.conversationHistory
        .filter(m => (m.sender_type === 'host' || m.sender?.type === 'host'))
        .find(m => {
          const msgTime = new Date(m.created_at || Date.now());
          const minutesAgo = (Date.now() - msgTime.getTime()) / (1000 * 60);
          return minutesAgo < 10;
        });

      if (recentHost) {
        result.hasRecentHostMessage = true;
        result.traces.push('Recent host message within 10 minutes (possible pre-approval or manual reply)');
      }
    }

    // Pre-approval detection for inquiries (high value from old production system)
    if (isInquiry && this.hospitableClient && inquiryId) {
      try {
        const inquiry = await this.hospitableClient.getInquiryDetails(inquiryId);

        if (inquiry) {
          const status = inquiry.status;
          const isPreApproved = status === 'pre_approved' || status === 'pre-approved' || status === 'approved';

          if (isPreApproved) {
            result.preApprovalDetected = true;
            result.traces.push('Pre-approval detected on inquiry (fast path should be used)');
          }

          // Also try to fetch recent messages to look for explicit pre-approval language
          try {
            const messages = await this.hospitableClient.getConversationMessages(inquiryId, 8);
            const recentHostPreApproval = messages
              .filter(m => (m.sender_type === 'host' || m.sender?.type === 'host'))
              .find(m => /pre.?approv|approved your request/i.test(m.body || ''));

            if (recentHostPreApproval) {
              result.preApprovalDetected = true;
              result.preApprovalMessage = recentHostPreApproval.body?.substring(0, 200);
              result.traces.push('Explicit pre-approval message found in conversation history');
            }
          } catch (msgErr) {
            // Non-fatal
          }
        }
      } catch (e) {
        result.traces.push('Pre-approval check failed (fail safe)');
      }
    }

    return {
      detected: true,
      ...result,
    };
  }
}
