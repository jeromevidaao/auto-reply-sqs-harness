import { BaseTool } from '../BaseTool.js';
import { getTimeBasedGreeting, analyzeGreetingContext } from '../../utils/timeGreeting.js';

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
      // Greeting signals (for first-message-of-day / first-host-message greetings)
      greeting: null,
    };

    // === Recent host message + duplicate risk check ===
    // Try to use live Hospitable data when available (preferred, like old production)
    let recentHostMessages = [];
    let allRecentMessages = [];

    if (this.hospitableClient && conversationId) {
      try {
        const messages = await this.hospitableClient.getConversationMessages(conversationId, 10);
        allRecentMessages = messages || [];
        recentHostMessages = allRecentMessages
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

          // Extra guard: if we (the host/harness) just sent a very short acknowledgment like "You're welcome"
          // in the last few minutes, treat as high duplicate risk for thank-you style messages.
          const shortAckRecent = recentHostMessages.some(m => {
            const b = (m.body || '').trim().toLowerCase();
            const mins = (Date.now() - new Date(m.created_at).getTime()) / (1000 * 60);
            return mins < 20 && (b === "you're welcome!" || b === "you're welcome" || b.startsWith("you're welcome"));
          });
          if (shortAckRecent && /thank|thanks|appreciate|no rush/i.test(input || '')) {
            result.duplicateRisk = true;
            result.duplicateReason = 'We sent a "You\'re welcome" style reply very recently — strongly prefer not replying again';
            result.traces.push('Recent short host acknowledgment detected (anti double "You\'re welcome")');
          }
        }
      } catch (e) {
        result.traces.push('Live message history fetch failed (using fallback)');
      }
    }

    // === Greeting context analysis (first host message, first-of-day, recent greeting for suppression) ===
    // Uses live messages if fetched, else falls back to provided conversationHistory.
    // This powers smart "greet only on first message of day / first host reply" behavior.
    try {
      const messagesForGreeting = allRecentMessages.length > 0
        ? allRecentMessages
        : (context.conversationHistory || []);

      const greetingSignals = analyzeGreetingContext(messagesForGreeting, {
        recentGreetingWindowMin: 180
      });

      const timeInfo = getTimeBasedGreeting();

      result.greeting = {
        timeBasedGreeting: timeInfo.greeting,
        currentNYTime: timeInfo.currentTime,
        dayOfWeek: timeInfo.dayOfWeek,
        isFirstHostMessage: greetingSignals.isFirstHostMessage,
        lastHostWasPreviousDay: greetingSignals.lastHostWasPreviousDay,
        minutesSinceLastHost: greetingSignals.minutesSinceLastHost,
        hasRecentGreeting: greetingSignals.hasRecentGreeting,
        lastGreetingMessage: greetingSignals.lastGreetingMessage,
        lastGreetingTime: greetingSignals.lastGreetingTime,
        shouldUseGreeting: greetingSignals.shouldUseGreeting,
        lastHostMessagePreview: greetingSignals.lastHostMessagePreview || result.lastHostMessagePreview
      };

      if (greetingSignals.isFirstHostMessage) {
        result.traces.push('First host message in this conversation — greeting appropriate');
      }
      if (greetingSignals.lastHostWasPreviousDay) {
        result.traces.push('Last host message was previous day (NY) — treat as first-of-day, greeting recommended');
      }
      if (greetingSignals.shouldUseGreeting) {
        result.traces.push(`Greeting recommended: ${timeInfo.greeting}`);
      }
      if (greetingSignals.hasRecentGreeting) {
        result.traces.push('Recent greeting detected in host history — will suppress repeat formal greeting');
      }
    } catch (gErr) {
      // Non-fatal — greeting signals are best-effort enrichment
      result.traces.push('Greeting context analysis failed (non-fatal)');
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
