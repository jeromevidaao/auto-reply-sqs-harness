/**
 * First-pass category router.
 *
 * Production used to concatenate all ~44 category markdown files (including
 * conversation-judge.md and reflection.md) into every draft call. That bloated
 * the prompt (~158k chars), slowed Grok, and mixed reviewer instructions into
 * the writer.
 *
 * This router:
 *   - never loads reviewer docs on the first pass
 *   - always loads a tiny glue core (thanks + FYI)
 *   - adds at most MAX_ROUTED extra files from cheap keyword + tool signals
 *   - falls back to a small ops pack when nothing matches
 */

import { HE_AIRBNB_ONLY_CATEGORY_FILES, isHomeExchangeContext } from '../useCases/homeExchangeSharedCategories.js';
import { isUnlikelyEventIdiom } from '../tools/pets/petOverMax.js';

export const REVIEWER_CATEGORY_FILES = new Set([
  'conversation-judge.md',
  'reflection.md',
]);

/** Always on: thanks and FYI compose with every other intent. */
export const ALWAYS_CORE_FILES = ['thank-you-message.md', 'fyi-statements.md'];

/** When the router has no signal (brand-new / unclear), keep first-contact ops. */
export const FALLBACK_OPS_FILES = [
  'welcome-messages.md',
  'checkout.md',
  'self-checkin.md',
  'parking.md',
];

export const MAX_ROUTED = 4;

const APT2_LISTING_ID = '114663c5-0709-4eff-a868-fa9ebd6ed42d';

/**
 * Higher number = more important when we have to cap at MAX_ROUTED.
 * Cancellation / event / pets / parking / access beat food recs.
 */
const RULES = [
  {
    file: 'cancellation.md',
    priority: 100,
    also: ['cancellation-exception.md'],
    test: (msg) => /\bcancel|\brefund|\bexception|policy article|help\/article\/475/i.test(msg),
  },
  {
    file: 'event-request.md',
    priority: 95,
    test: (msg, ctx) => {
      if (isUnlikelyEventIdiom(msg)) return false;
      return !!(ctx.earlyEventDetection?.detected) ||
        /\b(party|gathering|event|wedding|celebration|bachelor|bachelorette)\b/i.test(msg);
    },
  },
  {
    file: 'pet-policy.md',
    priority: 90,
    test: (msg) => /\b(dogs?|pets?|pupp(?:y|ies)|cats?|furniture cover|sheets on the (?:bed|sofa))\b/i.test(msg),
  },
  {
    file: 'parking.md',
    priority: 88,
    test: (msg, ctx) =>
      !!(ctx.postCheckoutParkingInfo?.detected) ||
      /\b(park(?:ing)?|(?:the|our|my|a) car|car spot|second car|vehicle|vaughan)\b/i.test(msg),
  },
  {
    file: 'stay-extension.md',
    priority: 86,
    also: ['late-checkout.md'],
    test: (msg, ctx) =>
      !!(ctx.stayExtensionInfo?.detected) ||
      /\b(extend|extra night|one night earlier|begin (?:our )?stay|stay (?:a )?day (?:later|earlier)|checkout on the \d)\b/i.test(msg),
  },
  {
    file: 'late-checkout.md',
    priority: 84,
    test: (msg) =>
      /\b(late checkout|check(?:ing)? out (?:a )?bit later|leave (?:a )?bit later|checkout at 1[12]|12 or 1\s*pm)\b/i.test(
        msg
      ),
  },
  {
    file: 'check-in-instructions.md',
    priority: 83,
    test: (msg) =>
      /\b((?:check[-\s]?in|entry|access|arrival)\s+instructions?|how\s+to\s+get\s+into\s+(?:the\s+)?(?:unit|apartment)|get\s+into\s+the\s+unit|on this (?:text|thread|conversation))\b/i.test(
        msg
      ) ||
      (/\binstructions?\b/i.test(msg) && /\b(get\s+in|entry|check[-\s]?in|unit)\b/i.test(msg)),
  },
  {
        file: 'door-code-issues.md',
    priority: 82,
    also: ['not-checkin-day-access.md', 'post-stay-access.md'],
    test: (msg) =>
      /\b(door code|lockbox|lock ?out|can'?t get in|cannot get in|keypad|apt #|apartment number|code (?:doesn'?t|not) work|forgot to lock|left the door|automatically lock|auto[- ]lock)\b/i.test(
        msg
      ),
  },
  {
    file: 'apt2-street-door-lockout.md',
    priority: 81,
    test: (msg, ctx) =>
      listingIdOf(ctx) === APT2_LISTING_ID &&
      /\b(lock(?:ed)? out|street (?:door|stairs)|bolted|parking door)\b/i.test(msg),
  },
  {
    file: 'not-checkin-day-access.md',
    priority: 80,
    test: (msg) => /\b(apt #|apartment number|can'?t get in|what(?:'s| is) our apt)\b/i.test(msg),
  },
  {
    file: 'post-stay-access.md',
    priority: 79,
    test: (msg) => /\b(after checkout|left (?:already|yesterday)|code (?:already )?off)\b/i.test(msg),
  },
  {
    file: 'thermostat.md',
    priority: 78,
    also: ['hvac-remote-per-unit.md'],
    test: (msg, ctx) =>
      !!(ctx.earlyThermostatInfo?.guestMessageRelevant) ||
      /\b(ac\b|a\/c|heat(?:ing| pump)?|thermostat|nest|remote|too hot|too cold|no air)\b/i.test(msg),
  },
  {
    file: 'early-checkin.md',
    priority: 76,
    also: ['self-checkin.md'],
    test: (msg, ctx) =>
      !!(ctx.unitReadiness) ||
      /\b(early check[- ]?in|ready (?:early|now)|arrive (?:early|around|before) 4|before 4\s*pm)\b/i.test(msg),
  },
  {
    file: 'self-checkin.md',
    priority: 74,
    test: (msg) => /\b(self[- ]check[- ]?in|how do (?:we|i) get in|check[- ]in instructions)\b/i.test(msg),
  },
  {
    file: 'welcome-messages.md',
    priority: 72,
    test: (msg, ctx) => {
      const bookingIntro = /\b(just booked|so excited|looking forward to (?:our|the) stay|first (?:visit|time)|booked your)\b/i.test(msg);
      if (bookingIntro) return true;
      if (!isLikelyFirstHost(ctx)) return false;
      const shortAck = /^(?:hi|hey|hello|ok|okay|thanks|thank you)[\s!.]*$/i.test(String(msg).trim());
      return shortAck;
    },
  },
  {
    file: 'checkout.md',
    priority: 70,
    test: (msg) => /\b(check[- ]?out|10\s*am|leave the keys|departure)\b/i.test(msg),
  },
  {
    file: 'wifi.md',
    priority: 68,
    test: (msg) => /\b(wifi|wi-fi|password|network name|internet)\b/i.test(msg),
  },
  {
    file: 'misc-questions.md',
    priority: 67,
    test: (msg) =>
      /\b(toiletries|shampoo|soap|bath towels|provide towels|tap water|drink the water|which floor|how many (?:flights|stairs)|cooking utensils|cookware|crib|pack n play|pack and play|coffee|keurig|coffee maker|coffeemaker)\b/i.test(
        msg
      ),
  },
  {
    file: 'laundry.md',
    priority: 66,
    test: (msg) => /\b(laundry|laundromat|washer|dryer)\b/i.test(msg),
  },
  {
    file: 'extra-linens-towels.md',
    priority: 64,
    also: ['studio-futon.md'],
    test: (msg) =>
      /\b(extra (?:linens?|sheets?|towels?)|more towels|crib|pack n play|pack and play|sofa bed|futon)\b/i.test(msg),
  },
  {
    file: 'luggage.md',
    priority: 62,
    test: (msg) => /\b(luggage|bags?|drop off|store (?:our|my) bags)\b/i.test(msg),
  },
  {
    file: 'directions.md',
    priority: 60,
    test: (msg) => /\b(old port|how far|walk to|directions|where (?:is|are) you|uber|drive from)\b/i.test(msg),
  },
  {
    file: 'ev-charger.md',
    priority: 58,
    test: (msg) => /\b(ev charger|electric (?:car|vehicle)|tesla|charge(?:r)? the car)\b/i.test(msg),
  },
  {
    file: 'review.md',
    priority: 56,
    test: (msg) => /\b(five star|5 star|left a review|google review|airbnb review)\b/i.test(msg),
  },
  {
    file: 'security-deposit.md',
    priority: 54,
    test: (msg) => /\b(security deposit|deposit back)\b/i.test(msg),
  },
  {
    file: 'payment-method-update.md',
    priority: 52,
    test: (msg) => /\b(payment method|update (?:my )?card|new credit card)\b/i.test(msg),
  },
  {
    file: 'off-platform-booking.md',
    priority: 50,
    test: (msg) =>
      /\b(venmo|zelle|pay (?:you )?directly|book off|book directly|avoid (?:the )?fees|off[- ]platform|bypass (?:airbnb|the platform))\b/i.test(
        msg
      ),
  },
  {
    file: 'pricing.md',
    priority: 48,
    test: (msg) => /\b(price|rate|discount|cheaper|too expensive)\b/i.test(msg),
  },
  {
    file: 'guest-count-change.md',
    priority: 46,
    test: (msg) => /\b(extra guest|another person|one more guest|change (?:the )?guest count)\b/i.test(msg),
  },
  {
    file: 'damage-report.md',
    priority: 44,
    test: (msg) => /\b(broke|broken|damage|spill(?:ed)?|stained)\b/i.test(msg),
  },
  {
    file: 'food-recommendations.md',
    priority: 42,
    test: (msg) => /\b(restaurant|dinner|breakfast spot|food rec|where (?:should|to) eat)\b/i.test(msg),
  },
  {
    file: 'hotel-recommendation.md',
    priority: 40,
    test: (msg) => /\b(hotel|place to stay (?:nearby|else))\b/i.test(msg),
  },
  {
    file: 'july-4th-fireworks.md',
    priority: 38,
    test: (msg) => /\b(firework|july 4|4th of july|independence day)\b/i.test(msg),
  },
  {
    file: 'outdoor-trash.md',
    priority: 36,
    test: (msg) => /\b(trash|garbage|recycling|dumpster)\b/i.test(msg),
  },
  {
    file: 'street-safety-noise.md',
    priority: 34,
    test: (msg) => /\b(nois(?:e|y)|loud|safe(?:ty)?|sirens?|light sleepers)\b/i.test(msg),
  },
  {
    file: 'condo-comparison.md',
    priority: 32,
    test: (msg) => /\b(which (?:unit|apt)|difference between|compare)\b/i.test(msg),
  },
  {
    file: 'hvac-remote-per-unit.md',
    priority: 30,
    test: (msg) => /\b(each remote|one remote|per (?:room|unit) remote)\b/i.test(msg),
  },
  {
    file: 'studio-futon.md',
    priority: 28,
    test: (msg) => /\b(futon|studio sofa)\b/i.test(msg),
  },
];

function listingIdOf(context = {}) {
  return String(context.listingId || context.listing_id || '');
}

function isLikelyFirstHost(context = {}) {
  const history = context.conversationHistory;
  if (Array.isArray(history) && history.some((m) => {
    const t = String(m?.sender_type || m?.role || '').toLowerCase();
    return t === 'host' || t === 'owner';
  })) {
    return false;
  }
  if (context.conversationTraces?.hasRecentHostMessage) return false;
  if (context.conversationTraces?.recentWelcomeSent) return false;
  return true;
}

function uniqueKeepOrder(files) {
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} [opts.guestMessage]
 * @param {object} [opts.context]
 * @returns {{ files: string[], reasons: string[], usedFallback: boolean }}
 */
export function routeCategoryFiles({ guestMessage = '', context = {} } = {}) {
  const msg = String(guestMessage || context.originalMessage || '');
  const hits = [];

  for (const rule of RULES) {
    try {
      if (!rule.test(msg, context)) continue;
    } catch {
      continue;
    }
    hits.push({ file: rule.file, priority: rule.priority, also: rule.also || [] });
  }

  hits.sort((a, b) => b.priority - a.priority);

  const routed = [];
  const reasons = [];
  for (const hit of hits) {
    if (routed.length >= MAX_ROUTED) break;
    if (!routed.includes(hit.file)) {
      routed.push(hit.file);
      reasons.push(hit.file);
    }
    for (const extra of hit.also) {
      if (routed.length >= MAX_ROUTED) break;
      if (!routed.includes(extra)) {
        routed.push(extra);
        reasons.push(`${extra} (with ${hit.file})`);
      }
    }
  }

  let usedFallback = false;
  if (routed.length === 0) {
    const thanksOnly = /thank/i.test(msg) && String(msg).trim().length < 120;
    if (!thanksOnly) {
      routed.push(...FALLBACK_OPS_FILES.slice(0, MAX_ROUTED));
      usedFallback = true;
      reasons.push('fallback-ops');
    }
  }

  let files = uniqueKeepOrder([...ALWAYS_CORE_FILES, ...routed]);

  if (isHomeExchangeContext(context)) {
    files = files.filter((f) => !HE_AIRBNB_ONLY_CATEGORY_FILES.has(f));
  }

  files = files.filter((f) => !REVIEWER_CATEGORY_FILES.has(f));

  return { files, reasons, usedFallback };
}

export function isReviewerCategoryFile(name) {
  return REVIEWER_CATEGORY_FILES.has(String(name || ''));
}
