/**
 * Shared SQS auto-reply categories for Home Exchange.
 *
 * HE keeps its own first-message / fee / pre-approval path. After that,
 * most Airbnb operational categories apply to the same Pine units
 * (check-in 4pm, checkout 10am, parking, wifi, laundry, thanks, …).
 *
 * Airbnb-only booking/payment/cancellation categories stay off HE.
 * Send is always via the HomeExchange client — never Hospitable.
 */

export const HE_AIRBNB_ONLY_CATEGORIES = new Set([
  'NEW_RESERVATION_WELCOME',
  'NEW_INQUIRY_WELCOME',
  'CANCELLATION',
  'CANCELLATION_POLICY',
  'CANCELLATION_NOTIFICATION',
  'CANCELLATION_POLICY_EXCEPTION',
  'PAYMENT_METHOD_UPDATE',
  'OFF_PLATFORM_BOOKING',
  'SECURITY_DEPOSIT',
]);

/** Category markdown files that must not be loaded for HE prompts. */
export const HE_AIRBNB_ONLY_CATEGORY_FILES = new Set([
  'welcome-messages.md',
  'cancellation.md',
  'cancellation-exception.md',
  'off-platform-booking.md',
  'payment-method-update.md',
]);

const OPERATIONAL_ASK =
  /check.?in|check.?out|wifi|password|parking|laundry|door code|lockbox|lock out|early|late checkout|heat|ac\b|thermostat|linens|towels|directions|old port|fee is fine|pre-?approv|available|dates|pets?|ev charger|trash|code/i;

export function isHomeExchangeContext(context = {}) {
  const platform = String(context.platform || context.source || context.channel || '').toLowerCase();
  return context.homeExchange === true || platform === 'homeexchange';
}

export function firstNameOf(guestName) {
  const name = String(guestName || '').trim().split(/\s+/)[0];
  return name || '';
}

export function categoryListOf(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value) return [String(value)];
  return [];
}

export function isAirbnbOnlyHeCategory(value) {
  return categoryListOf(value).some((c) => HE_AIRBNB_ONLY_CATEGORIES.has(c));
}

export function thisTurnWantsHePreapprove(text) {
  const raw = String(text || '');
  // HE system line after the guest already finalized — not a request to pre-approve.
  if (/has finalized the exchange/i.test(raw)) return false;
  return (
    /cleaning fee is fine|fee is fine|happy to pay (the )?(cleaning )?fee|ok(?:ay)? (with |paying )?the (cleaning )?fee|fee works/i.test(
      raw
    ) || /\bpre-?approv|\bfinalize\b/i.test(raw)
  );
}

/** Pure / short courtesy thanks with no operational question. */
export function isHeSharedThankYouMessage(text) {
  const msg = String(text || '').trim();
  if (!msg || msg.length > 240) return false;
  if (/\?/.test(msg)) return false;
  if (!/(thank you|thanks|thx|appreciate)/i.test(msg)) return false;
  if (OPERATIONAL_ASK.test(msg)) return false;
  return true;
}

export function isHeCheckoutTimeQuestion(text) {
  const lower = String(text || '').toLowerCase();
  if (!/check[\s-]?out/.test(lower)) return false;
  return /(time|when|latest|what time|how late)/i.test(lower);
}

export function isHeCheckinTimeQuestion(text) {
  const lower = String(text || '').toLowerCase();
  if (!/check[\s-]?in/.test(lower)) return false;
  if (/early/.test(lower)) return false;
  return /(time|when|what time|starts?)/i.test(lower);
}

export function buildHeThankYouDraft(guestName) {
  const name = firstNameOf(guestName);
  return {
    typeOfMessageReceived: 'THANK_YOU_MESSAGE',
    shouldReply: true,
    proposedResponse: name ? `You're welcome, ${name}!` : "You're welcome!",
    reason: 'homeexchange_shared_thank_you',
    sharedCategory: true,
  };
}

export function buildHeCheckoutTimeDraft(text, guestName) {
  const name = firstNameOf(guestName);
  const thanks = /(thank you|thanks)/i.test(String(text || ''));
  const opener = thanks
    ? name
      ? `You're welcome, ${name}! `
      : "You're welcome! "
    : '';
  return {
    typeOfMessageReceived: thanks ? ['THANK_YOU_MESSAGE', 'CHECKOUT'] : 'CHECKOUT',
    shouldReply: true,
    proposedResponse: `${opener}Checkout is strictly at 10am.`,
    reason: 'homeexchange_shared_checkout_time',
    sharedCategory: true,
  };
}

export function buildHeCheckinTimeDraft(text, guestName) {
  const name = firstNameOf(guestName);
  const thanks = /(thank you|thanks)/i.test(String(text || ''));
  const opener = thanks
    ? name
      ? `You're welcome, ${name}! `
      : "You're welcome! "
    : '';
  return {
    typeOfMessageReceived: thanks ? ['THANK_YOU_MESSAGE', 'CHECK_IN_TIME_QUESTION'] : 'CHECK_IN_TIME_QUESTION',
    shouldReply: true,
    proposedResponse: `${opener}Check-in is at 4pm.`,
    reason: 'homeexchange_shared_checkin_time',
    sharedCategory: true,
  };
}

export function buildDeterministicHeSharedDraft({ message, guestName } = {}) {
  if (isHeSharedThankYouMessage(message)) return buildHeThankYouDraft(guestName);
  if (isHeCheckoutTimeQuestion(message)) return buildHeCheckoutTimeDraft(message, guestName);
  if (isHeCheckinTimeQuestion(message)) return buildHeCheckinTimeDraft(message, guestName);
  return null;
}

export function shouldRunSharedHeCategories({ isFirst, heDraftSendable, preapproveOk } = {}) {
  if (isFirst) return false;
  if (preapproveOk) return false;
  if (heDraftSendable) return false;
  return true;
}

export function mapHeHistoryForAgent(messages = [], guestName = null) {
  const guestFirst = firstNameOf(guestName).toLowerCase();
  return (messages || []).map((m) => {
    const roleRaw = String(m?.sender_type || m?.sender?.type || m?.role || '').toLowerCase();
    const author = String(m?.author?.first_name || m?.sender?.first_name || '').toLowerCase();
    let role = 'host';
    if (roleRaw === 'guest' || roleRaw === 'exchanger') role = 'guest';
    else if (roleRaw === 'host' || roleRaw === 'owner') role = 'host';
    else if (guestFirst && author && author === guestFirst) role = 'guest';
    const content = String(m?.content || m?.body || m?.text || '');
    return {
      role,
      sender_type: role,
      content,
      body: content,
    };
  });
}

export function heSharedAgentContext({
  guestName,
  checkIn,
  checkOut,
  conversationId,
  conversationHistory,
  listingId,
  propertyName,
} = {}) {
  return {
    platform: 'homeexchange',
    source: 'homeexchange',
    homeExchange: true,
    requireLiveConversationHistory: false,
    guestName,
    checkIn,
    checkOut,
    conversation_id: conversationId,
    conversationId,
    conversationHistory: mapHeHistoryForAgent(conversationHistory, guestName),
    listingId,
    propertyName,
  };
}

function draftFromAgentDecision(decision) {
  if (!decision || typeof decision !== 'object') return null;
  if (isAirbnbOnlyHeCategory(decision.typeOfMessageReceived)) {
    return {
      typeOfMessageReceived: decision.typeOfMessageReceived,
      shouldReply: false,
      proposedResponse: null,
      reason: 'homeexchange_airbnb_only_category',
      sharedCategory: true,
    };
  }
  const text = String(decision.proposedResponse || '').trim();
  if (!decision.shouldReply || !text || text.toLowerCase() === 'none') {
    return {
      typeOfMessageReceived: decision.typeOfMessageReceived || 'OTHER_MESSAGE',
      shouldReply: false,
      proposedResponse: text || null,
      reason: 'homeexchange_shared_no_reply',
      sharedCategory: true,
    };
  }
  return {
    typeOfMessageReceived: decision.typeOfMessageReceived,
    shouldReply: true,
    proposedResponse: text,
    reason: 'homeexchange_shared_agent',
    sharedCategory: true,
    confidence: decision.confidence,
  };
}

/**
 * Deterministic shared drafts first (thanks / check-in / checkout).
 * Other shared categories go through GuestMessagingAgent.processMessage
 * (no Hospitable send). Inject `sharedCategoryRunner` in tests.
 */
export async function runSharedHeCategories({
  message,
  guestName,
  checkIn,
  checkOut,
  conversationId,
  conversationHistory,
  listingId,
  propertyName,
  sharedCategoryAgent = null,
  sharedCategoryRunner = null,
} = {}) {
  const deterministic = buildDeterministicHeSharedDraft({ message, guestName });
  if (deterministic) return deterministic;

  if (typeof sharedCategoryRunner === 'function') {
    const out = await sharedCategoryRunner({
      message,
      guestName,
      checkIn,
      checkOut,
      conversationId,
      conversationHistory,
    });
    if (out && isAirbnbOnlyHeCategory(out.typeOfMessageReceived)) {
      return {
        ...out,
        shouldReply: false,
        proposedResponse: null,
        reason: 'homeexchange_airbnb_only_category',
        sharedCategory: true,
      };
    }
    return out;
  }

  if (!sharedCategoryAgent || typeof sharedCategoryAgent.processMessage !== 'function') {
    return {
      typeOfMessageReceived: 'OTHER_MESSAGE',
      shouldReply: false,
      proposedResponse: null,
      reason: 'homeexchange_shared_no_agent',
      sharedCategory: true,
    };
  }

  const decision = await sharedCategoryAgent.processMessage(
    message,
    heSharedAgentContext({
      guestName,
      checkIn,
      checkOut,
      conversationId,
      conversationHistory,
      listingId,
      propertyName,
    })
  );
  return draftFromAgentDecision(decision);
}
