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

        // Make the live messages available to agent so _buildUserPrompt can include real conversationHistory.
        // This gives the LLM (and judge/reflection) visibility into prior host messages (e.g. recent "Good morning")
        // for anti-repetition, context, and better greeting decisions even if trace signals have lag.
        if (allRecentMessages.length > 0) {
          result.recentConversationMessages = allRecentMessages;
        }

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

    // Host reactions on the *current* guest message (provided in webhook payload for created/updated events).
    // If host manually reacted (e.g. thumbs up to a "thank you"), treat as recent host activity to suppress
    // auto "you're welcome" style replies (avoids double-acknowledgment when host has already engaged manually).
    const incomingReactions = context.reactions || [];
    if (Array.isArray(incomingReactions) && incomingReactions.length > 0) {
      const hasHostReaction = incomingReactions.some(r => {
        const st = (r.sender_type || (r.sender && r.sender.type) || '').toLowerCase();
        return st === 'host';
      });
      if (hasHostReaction) {
        result.hasRecentHostMessage = true;
        result.minutesSinceLastHostMessage = 0.1;
        result.traces.push('Host reaction (e.g. thumbs up) present on this guest message — recent host activity');
        if (/thank|thanks|appreciate|amazing|great|cool/i.test(input || '')) {
          result.duplicateRisk = true;
          result.duplicateReason = 'Host already reacted manually to this thank-you style message; suppress auto ack';
          result.traces.push('Host reaction on thank-you/ack message — will bias toward no reply');
        }
      }
    }

    // === Host-declared early unit readiness (CRITICAL anti-contradiction signal) ===
    // Scan recent host messages for explicit statements that the unit/apt is ready for early / now check-in.
    // When true, first-pass, reflection, and judge MUST ensure the response NEVER re-states 4pm policy or "if ready earlier".
    // This directly fixes the bug where host said "unit is ready for you to check in now" then auto-reply contradicted with 4pm.
    // Uses live recentHostMessages if available; falls back to provided conversationHistory.
    const hostMessagesForReadyScan = recentHostMessages.length > 0
      ? recentHostMessages
      : (context.conversationHistory || []).filter(m => (m.sender_type === 'host' || (m.sender && m.sender.type === 'host')));
    const earlyReadyPhrases = [
      /unit is ready/i,
      /ready for you to check in/i,
      /ready for check-?in/i,
      /check in (now|early|anytime)/i,
      /the (unit|apartment|place|home|listing) is ready/i,
      /pleased to let you know.*ready/i,
      /you can check in (anytime|early|now)/i,
      /self-check-in.*anytime/i,
      /arrive (early|anytime|now)/i,
      /unit ready for you/i
    ];
    let earlyUnitReadyOffered = false;
    let earlyReadyMessagePreview = null;
    for (const m of hostMessagesForReadyScan) {
      const body = (m.body || m.text || '').toLowerCase();
      if (earlyReadyPhrases.some(re => re.test(body))) {
        earlyUnitReadyOffered = true;
        earlyReadyMessagePreview = (m.body || m.text || '').substring(0, 160);
        break;
      }
    }
    result.earlyUnitReadyOffered = earlyUnitReadyOffered;
    if (earlyUnitReadyOffered) {
      result.earlyReadyMessagePreview = earlyReadyMessagePreview;
      result.traces.push('Early unit ready declared by host in recent/prior message — never contradict with 4pm policy');
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
        lastHostMessagePreview: greetingSignals.lastHostMessagePreview || result.lastHostMessagePreview,
        numHostMessages: greetingSignals.numHostMessages,
        numGuestMessages: greetingSignals.numGuestMessages
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

      // Cross-check: if the earlier recent-host block saw a host message within greeting-relevant window (~3h),
      // force-suppress shouldUseGreeting. This defends against cases where analyzeGreetingContext on the list
      // computed a "first" because of fetch timing, while the recentHostMessages filter (same data) saw recency.
      if (result.hasRecentHostMessage &&
          result.minutesSinceLastHostMessage != null &&
          result.minutesSinceLastHostMessage > 0 &&
          result.minutesSinceLastHostMessage < 180) {
        if (result.greeting) {
          result.greeting.shouldUseGreeting = false;
          result.greeting.suppressedByRecentHost = true;
        }
        result.traces.push('Greeting suppressed via recent host trace cross-check (<3h host activity)');
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
