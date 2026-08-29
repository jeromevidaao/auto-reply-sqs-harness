/**
 * Airbnb-style first-engagement opener for Home Exchange.
 *
 * Policy (dates open + fee ask, or dates not open) stays deterministic.
 * This only writes the 1–2 sentence ack of what the guest already said.
 */

import { GrokLLMAdapter } from '../adapters/llm/grok.js';

const OCCASIONS = [
  [/halloween/i, 'Halloween'],
  [/thanksgiving/i, 'Thanksgiving'],
  [/\bchristmas\b|\bxmas\b/i, 'Christmas'],
  [/new year'?s|\bnye\b/i, 'New Year'],
  [/birthday/i, 'a birthday'],
  [/anniversary/i, 'an anniversary'],
  [/wedding/i, 'a wedding'],
  [/graduation/i, 'a graduation'],
  [/spring break/i, 'spring break'],
  [/long weekend/i, 'a long weekend'],
];

const LANDMARKS = [
  [/deering\s+(oaks|park)/i, 'Deering Park'],
  [/old port/i, 'the Old Port'],
  [/west end/i, 'the West End'],
  [/back cove/i, 'Back Cove'],
  [/waterfront/i, 'the waterfront'],
];

function forbiddenAckRe() {
  return /cleaning fee|after your stay|after you leave|those dates|calendar|available|not open|accept the request|pre-?approv|blocked those dates|feel free to book|let me know if you have any questions|happy to hear|self-check-in|\b4pm\b|\b10am\b|off-street parking|\$\d+|fee is included/i;
}

export function extractHeFirstMessageHooks(message = '') {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  const hooks = {
    complimentPlace: false,
    occasion: null,
    family: null,
    landmark: null,
    city: null,
    firstVisit: false,
    raw: text,
  };
  if (!text) return hooks;

  if (
    /(place|home|apartment|listing).{0,40}(looks?\s+great|beautiful|lovely|wonderful|perfect|ideal|\bgem\b)/i.test(text) ||
    /(looks?\s+great|beautiful|lovely|wonderful|\bis a gem\b)/i.test(text)
  ) {
    hooks.complimentPlace = true;
  }

  for (const [re, label] of OCCASIONS) {
    if (re.test(text)) {
      hooks.occasion = label;
      break;
    }
  }

  if (/\bgrand(?:child|kid)/i.test(text)) hooks.family = 'grandchildren';
  else if (/\b(our |my )?(kids|children)\b/i.test(text)) hooks.family = 'kids';
  else if (/\b(parents|mom|dad|mother|father)\b/i.test(text)) hooks.family = 'family';
  else if (/\b(daughter|son)\b/i.test(text)) hooks.family = 'family';
  else if (/\bfamily\b/i.test(text)) hooks.family = 'family';

  for (const [re, label] of LANDMARKS) {
    if (re.test(text)) {
      hooks.landmark = label;
      break;
    }
  }

  if (/\bportland\b/i.test(text)) hooks.city = 'Portland';
  else if (/\bmaine\b/i.test(text)) hooks.city = 'Maine';

  if (/first time|haven'?t been back|never been/i.test(text)) hooks.firstVisit = true;

  return hooks;
}

function joinAckParts(parts) {
  if (parts.length === 0) return 'thanks for reaching out';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]}, and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * Deterministic 1–2 clause ack. Empty / "hi" messages stay generic.
 */
export function buildHeFirstAckClause(message = '') {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text || /^(hi|hello|hey|thanks|thank you|ok|okay)[!.\s]*$/i.test(text)) {
    return 'thanks for reaching out';
  }

  const hooks = extractHeFirstMessageHooks(text);
  const parts = [];

  if (hooks.complimentPlace) {
    parts.push('thanks for the kind words about the place');
  }

  if (hooks.family && hooks.landmark) {
    parts.push(`how nice that your ${hooks.family} live just across ${hooks.landmark}`);
  } else if (hooks.family) {
    parts.push(`how nice that you will be near your ${hooks.family}`);
  } else if (hooks.landmark) {
    parts.push(`${hooks.landmark} is a great area to be close to`);
  }

  if (hooks.occasion && hooks.city) {
    parts.push(`${hooks.occasion} in ${hooks.city} sounds like a fun trip`);
  } else if (hooks.occasion) {
    parts.push(`${hooks.occasion} sounds like a fun trip`);
  } else if (hooks.firstVisit && hooks.city) {
    parts.push(`a first visit to ${hooks.city} is a great reason to stay`);
  } else if (hooks.firstVisit) {
    parts.push('a first visit is a great reason to stay');
  } else if (hooks.city && parts.length === 0) {
    parts.push(`a trip to ${hooks.city} sounds lovely`);
  }

  if (parts.length === 0) return 'thanks for your message';
  return joinAckParts(parts.slice(0, 2));
}

export function normalizeHeFirstAck(ack) {
  return String(ack || '')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .replace(/^(hi|hello|hey)\s+[^,—.]+[,—-]\s*/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}

export function isSafeHeFirstAck(ack) {
  const raw = String(ack || '').trim();
  if (!raw) return false;
  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening))\b/i.test(raw)) return false;
  const text = normalizeHeFirstAck(raw);
  if (!text) return false;
  if (text.length < 12 || text.length > 280) return false;
  if (forbiddenAckRe().test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > 45) return false;
  return true;
}

export function composeHeFirstReply({
  guestName,
  ackClause,
  policySentence,
  extraParagraph,
} = {}) {
  const name = String(guestName || 'there').trim().split(/\s+/)[0] || 'there';
  const ack = normalizeHeFirstAck(ackClause) || 'thanks for reaching out';
  const policy = String(policySentence || '').trim();
  let text = `Hi ${name} — ${ack}.`;
  if (policy) text += ` ${policy}`;
  const extra = String(extraParagraph || '').trim();
  if (extra) text += `\n\n${extra}`;
  return text;
}

export const HE_FIRST_ACK_SYSTEM = `You write ONLY the first-sentence acknowledgment for a Home Exchange host reply.
The host (Jerome & Ruby, Pine apartments in Portland, Maine) will add a separate operational sentence about calendar or the cleaning fee. You must not write that part.

Write 1 sentence (max 2), at most 40 words, that acknowledges a SPECIFIC detail the guest already said — the way a thoughtful Airbnb host would.
Examples of the right shape:
- thanks for the kind words about the place, and how nice that your grandchildren live just across Deering Park
- Halloween in Portland sounds like a fun trip
- how nice that you will be visiting family in the West End

Rules:
- No greeting (no Hi / Hello / Good morning).
- No calendar, availability, dates open/closed, cleaning fee, payment, pre-approval, booking, 4pm, 10am, parking, check-in, checkout.
- Never say a cleaning fee is included. Guests pay the cleaning fee separately after the stay.
- Do not invent facts the guest did not state.
- Do not use "happy to hear", "let me know if you have any questions", or "feel free to book".
- Do not sign off.
- Output only the sentence(s).`;

export function createHeFirstAckWriter(llm = null) {
  return async function writeHeFirstAck({ message, guestName } = {}) {
    const adapter = llm || new GrokLLMAdapter();
    const user = [
      guestName ? `Guest name: ${guestName}` : null,
      'Guest first message:',
      String(message || '').trim(),
    ]
      .filter(Boolean)
      .join('\n');
    const raw = await adapter.complete(HE_FIRST_ACK_SYSTEM, user);
    return normalizeHeFirstAck(raw);
  };
}

export async function applyHeFirstAckWriter(
  draft,
  { message, guestName, writer } = {}
) {
  if (!draft?.shouldReply || !draft.policySentence) return draft;
  if (typeof writer !== 'function') return draft;
  const text = String(message || '').trim();
  if (text.length < 12) return draft;
  try {
    const polished = await writer({ message: text, guestName, reason: draft.reason });
    if (!isSafeHeFirstAck(polished)) return draft;
    const ackClause = normalizeHeFirstAck(polished);
    return {
      ...draft,
      ackClause,
      ackSource: 'writer',
      proposedResponse: composeHeFirstReply({
        guestName,
        ackClause,
        policySentence: draft.policySentence,
        extraParagraph: draft.extraParagraph,
      }),
    };
  } catch (err) {
    console.warn('[HomeExchange] first-ack writer failed', err?.message || err);
    return draft;
  }
}
