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
    const reservationId = context.reservationId || context.conversation_id || context.airbnb_conversation_id;
    const inquiryId = context.inquiryId || (context.reservationId === null ? (context.conversation_id || context.airbnb_conversation_id) : null);
    const conversationId = inquiryId || reservationId;
    const isInquiry = !context.reservationId && !!inquiryId;

    const result = {
      hasRecentHostMessage: false,
      minutesSinceLastHostMessage: null,
      lastHostMessagePreview: null,
      preApprovalDetected: false,
      preApprovalMessage: null,
      duplicateRisk: false,
      duplicateReason: null,
      traces: [],
    };

    // === Recent host message + duplicate risk check ===
    // Try to use live Hospitable data when available (preferred, like old production)
    let recentHostMessages = [];

    if (this.hospitableClient && conversationId) {
      try {
        const messages = await this.hospitableClient.getConversationMessages(conversationId, 10);
        recentHostMessages = messages
          .filter(m => (m.sender_type === 'host' || m.sender?.type === 'host'))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        if (recentHostMessages.length > 0) {
          const lastHost = recentHostMessages[0];
          const msgTime = new Date(lastHost.created_at);
          const minutesAgo = (Date.now() - msgTime.getTime()) / (1000 * 60);

          result.hasRecentHostMessage = minutesAgo < 15; // Slightly wider window than before
          result.minutesSinceLastHostMessage = Math.round(minutesAgo * 10) / 10;
          result.lastHostMessagePreview = (lastHost.body || '').substring(0, 180);

          if (result.hasRecentHostMessage) {
            result.traces.push(`Recent host message ${result.minutesSinceLastHostMessage.toFixed(1)} min ago (duplicate risk)`);
          }

          // Simple duplicate risk heuristic (similar to old hasDuplicateMessage)
          const currentMsgLower = (input || '').toLowerCase();
          const similarRecent = recentHostMessages.some(m => {
            const hostMsg = (m.body || '').toLowerCase();
            return currentMsgLower.length > 20 &&
                   hostMsg.includes(currentMsgLower.substring(0, 30));
          });

          if (similarRecent) {
            result.duplicateRisk = true;
            result.duplicateReason = 'Recent host reply appears to address a very similar question';
            result.traces.push('High duplicate risk detected based on recent host reply content');
          }
        }
      } catch (e) {
        result.traces.push('Live message history fetch failed (using fallback)');
      }
    }

    // Fallback to provided conversationHistory if live fetch wasn't possible or failed
    if (!result.hasRecentHostMessage && context.conversationHistory && context.conversationHistory.length > 0) {
      const recentHost = context.conversationHistory
        .filter(m => (m.sender_type === 'host' || m.sender?.type === 'host'))
        .find(m => {
          const msgTime = new Date(m.created_at || Date.now());
          const minutesAgo = (Date.now() - msgTime.getTime()) / (1000 * 60);
          return minutesAgo < 10;
        });

      if (recentHost) {
        result.hasRecentHostMessage = true;
        result.minutesSinceLastHostMessage = Math.round(((Date.now() - new Date(recentHost.created_at || Date.now()).getTime()) / (1000 * 60)) * 10) / 10;
        result.lastHostMessagePreview = (recentHost.body || '').substring(0, 180);
        result.traces.push(`Recent host message within ~10 min (fallback from history) - duplicate risk`);
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

    if (result.duplicateRisk) {
      result.traces.push(result.duplicateReason);
    }

    return {
      detected: true,
      ...result,
    };
  }
}
