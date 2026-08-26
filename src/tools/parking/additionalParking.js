/**
 * Additional / second-car parking (PARKING_ADDITIONAL_QUESTION).
 *
 * John Apt 2 2026-08-26: guest mentioned a niece's wedding (trip purpose) and
 * asked for a second car. EventRequestTool treated "celebration" / "gathering"
 * as EVENT_REQUEST and overwrote the parking answer. When they clarified they
 * were not hosting a party, the same event decline was drafted again and the
 * send was skipped as equivalent.
 */

export const ADDITIONAL_PARKING_SNIPPET =
  'We only have on-site parking for one car. For paid parking, we have 192-234 Vaughan Street Parking nearby. The alternative is to find street parking in the area, usually towards the Western Promenade. I recommend using the SpotHero application, where you can book in advance and get cheaper rates.';

export const NO_PARTY_THANKS =
  'Thanks for confirming that you will not be hosting a party.';

/**
 * Guest is asking about a second / extra vehicle, not their one included spot.
 * @param {string} message
 */
export function isAdditionalParkingAsk(message = '') {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) return false;
  if (
    /\b(?:second (?:car|vehicle)|two cars|2 cars|additional (?:car|parking|vehicle)|extra (?:car|vehicle)|more than one car)\b/.test(
      lower
    )
  ) {
    return true;
  }
  if (/\b(?:two|2) vehicles?\b/.test(lower)) return true;
  if (/\bparking for (?:a |the )?second\b/.test(lower)) return true;
  if (
    /\banother (?:spot|space|stall)\b/.test(lower) &&
    /\b(?:park|parking|car|vehicle)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

/**
 * Guest is denying / correcting an event/party assumption.
 * @param {string} message
 */
export function isEventHostingDenial(message = '') {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) return false;
  return (
    /\byou misunderstood\b/.test(lower) ||
    /\bnot looking to (?:plan|host|have)\b/.test(lower) ||
    /\bnot hosting\b/.test(lower) ||
    /\bwon'?t be hosting\b/.test(lower) ||
    /\bwill not be hosting\b/.test(lower) ||
    /\bnot planning (?:a |an )?(?:party|gathering|event|celebration)\b/.test(lower) ||
    /\bnot looking to plan a gathering\b/.test(lower)
  );
}

/**
 * Guest wants to host a party / gathering / event at the listing.
 * @param {string} message
 */
export function isEventHostingAsk(message = '') {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) return false;
  if (isEventHostingDenial(lower)) return false;
  return (
    /\bget[- ]?together\b/.test(lower) ||
    /\bbirthday party\b/.test(lower) ||
    /\bpeople over\b/.test(lower) ||
    /\bhost(?:ing)?\b.{0,40}\b(?:party|event|people|gathering|celebration)\b/.test(lower) ||
    /\b(?:can we|is it (?:ok|okay)|would it be (?:ok|okay)|allowed to|thinking of having).{0,60}\b(?:party|event|gathering|people over|get[- ]?together)\b/.test(
      lower
    ) ||
    /\b(?:party|event|gathering)\b.{0,40}\b(?:here|at (?:the )?(?:apartment|apt|unit|place|property)|while we(?:'re| are) there)\b/.test(
      lower
    )
  );
}

/**
 * Wedding / celebration as trip purpose (niece's wedding in Portland), not hosting at the unit.
 * @param {string} message
 */
export function isTripPurposeEventMention(message = '') {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) return false;
  if (isEventHostingAsk(lower)) return false;
  const weddingTrip =
    /\b(?:niece'?s|nephew'?s|friend'?s|sister'?s|brother'?s|daughter'?s|son'?s|cousin'?s|family'?s)\s+wedding\b/.test(
      lower
    ) ||
    /\bcelebration of\b.{0,60}\bwedding\b/.test(lower) ||
    /\bcoming to \w+.{0,40}\bwedding\b/.test(lower) ||
    /\bfor (?:a |our |my |the )?(?:niece'?s |nephew'?s )?wedding\b/.test(lower);
  return weddingTrip;
}

/**
 * Canonical additional-parking body. Prepends the no-party thanks when the guest just clarified.
 * @param {{ deniedEvent?: boolean }} [opts]
 */
export function additionalParkingDraft({ deniedEvent = false } = {}) {
  if (deniedEvent) {
    return `${NO_PARTY_THANKS} ${ADDITIONAL_PARKING_SNIPPET}`;
  }
  return ADDITIONAL_PARKING_SNIPPET;
}
