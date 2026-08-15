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
