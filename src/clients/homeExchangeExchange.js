/** Pick the stay exchange on a conversation (our home, else first). */
export function pickExchangeFromConversation(conversation, homeId = '3202475') {
  const conv = conversation && typeof conversation === 'object' ? conversation : {};
  const list = Array.isArray(conv.exchanges)
    ? conv.exchanges
    : Array.isArray(conv.all_exchanges)
      ? conv.all_exchanges
      : [];
  if (!list.length) return null;
  const want = homeId != null ? String(homeId) : null;
  if (want) {
    const match = list.find((ex) => {
      const hid =
        ex?.home?.id != null
          ? String(ex.home.id)
          : ex?.home_id != null
            ? String(ex.home_id)
            : ex?.home != null
              ? String(ex.home)
              : null;
      return hid === want;
    });
    if (match) return match;
  }
  return list[0] || null;
}

export function isApprovedExchange(exchange) {
  if (!exchange || typeof exchange !== 'object') return false;
  if (exchange.finalized_at) return true;
  if (exchange.approved_at) return true;
  const st = exchange.status;
  if (st === 1 || st === '1') return true;
  if (typeof st === 'string' && /^(pre-?approved|approved)$/i.test(st)) return true;
  return false;
}

export function anyExchangeApproved(exchanges) {
  return (Array.isArray(exchanges) ? exchanges : []).some(isApprovedExchange);
}

export function exchangeAlreadyApproved(exchange, conversation = null) {
  if (isApprovedExchange(exchange)) return true;
  const acc = conversation?.accepted;
  if (acc === true || acc === 1 || acc === '1') return true;
  return false;
}

/** HE exchange.type: 1 = GuestPoints (WITH-GP), 2 = reciprocal home swap. */
export const HE_EXCHANGE_TYPE_GUESTPOINTS = 1;
export const HE_EXCHANGE_TYPE_RECIPROCAL = 2;
export const HE_PINE_HOME_IDS = new Set(['3202475', '3285044', '3285159']);
export const HE_STAY_REQUEST_DECLINED = new Set([
  'MANUALLY_DECLINED',
  'AUTOMATICALLY_DECLINED',
  'PAST_DATES_DECLINE',
]);

export function exchangeHomeId(exchange) {
  if (!exchange || typeof exchange !== 'object') return null;
  if (exchange.home?.id != null) return String(exchange.home.id);
  if (exchange.home_id != null) return String(exchange.home_id);
  if (exchange.home != null && typeof exchange.home !== 'object') return String(exchange.home);
  return null;
}

export function isCancelledExchange(exchange) {
  if (!exchange || typeof exchange !== 'object') return false;
  if (exchange.canceleted_at || exchange.canceled_at || exchange.cancelled_at) return true;
  const st = exchange.status;
  return st === 5 || st === '5';
}

export function conversationExchanges(conversation = null) {
  const conv = conversation && typeof conversation === 'object' ? conversation : {};
  if (Array.isArray(conv.exchanges)) return conv.exchanges;
  if (Array.isArray(conv.all_exchanges)) return conv.all_exchanges;
  return [];
}

export function pickTheirExchange(conversation = null) {
  return (
    conversationExchanges(conversation).find((ex) => {
      const hid = exchangeHomeId(ex);
      return hid && !HE_PINE_HOME_IDS.has(hid);
    }) || null
  );
}

export const HE_RECIPROCAL_CANNOT_DECLINE = 'reciprocal_cannot_decline';

export function stayRequestIsDeclined(stayRequest = null) {
  const st = String(stayRequest?.stayRequestStatus || '').toUpperCase();
  return HE_STAY_REQUEST_DECLINED.has(st);
}

/** HE has no pending-decline for reciprocal stay requests (400 Invalid exchange type). */
export function stayRequestIsReciprocal(stayRequest = null) {
  const t = String(stayRequest?.stayType || '').toUpperCase();
  return t === 'RECIPROCAL' || t === 'RECIPROCAL-WITH-GP';
}

export function conversationAlreadyDeclined(conversation = null, stayRequest = null) {
  if (stayRequestIsDeclined(stayRequest)) return true;
  if (stayRequestIsDeclined(conversation?.stayRequest)) return true;
  const acc = conversation?.accepted;
  if (acc === false || acc === 0 || acc === '0') return true;
  const list = conversationExchanges(conversation);
  if (list.length && list.every((ex) => isCancelledExchange(ex))) return true;
  return false;
}

function messageLooksReciprocal(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type_auto === 16 || m.type_auto === '16') return true;
  return /transformed the exchange into a reciprocal/i.test(
    String(m.content || m.body || m.text || '')
  );
}

/** True when this stay is a home swap (no GuestPoints), which Pine never accepts. */
export function isReciprocalHeExchange(exchange, { conversation = null, history = [] } = {}) {
  if (Number(exchange?.type) === HE_EXCHANGE_TYPE_RECIPROCAL) return true;
  const list = Array.isArray(conversation?.exchanges)
    ? conversation.exchanges
    : Array.isArray(conversation?.all_exchanges)
      ? conversation.all_exchanges
      : [];
  if (list.some((ex) => Number(ex?.type) === HE_EXCHANGE_TYPE_RECIPROCAL)) return true;
  return (Array.isArray(history) ? history : []).some(messageLooksReciprocal);
}
