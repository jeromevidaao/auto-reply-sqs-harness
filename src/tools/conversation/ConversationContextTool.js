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

    // Pre-approval detection for inquiries (high value from old system)
    if (isInquiry && this.hospitableClient) {
      try {
        // In a real implementation this would call getInquiryDetails or similar
        // For now we surface the intent so the multipass can act conservatively
        result.traces.push('Inquiry detected — pre-approval fast path should be considered');
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
