/**
 * Pet over-max (PET_QUESTIONS).
 *
 * Elizabeth Apt 3 2026-08-26: guest asked if a third senior dog would be an
 * issue given the listing 2-dog max ("In the unlikely event that our very
 * senior dog is still around for Thanksgiving"). EventRequestTool treated
 * "event" as EVENT_REQUEST and sent the no-parties decline.
 */

export const PET_OVER_MAX_SNIPPET =
  "Unfortunately we have a maximum 2 dogs policy, so we can't accommodate a third. Sorry — we had issues in the past with more than 2.";

/**
 * English idiom "in the (unlikely) event that …", not a request to host an event.
 * @param {string} message
 */
export function isUnlikelyEventIdiom(message = '') {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) return false;
  return (
    /\bin the (?:unlikely |possible )?event that\b/.test(lower) ||
    /\bunlikely event that\b/.test(lower) ||
    /\bin the unlikely event\b/.test(lower)
  );
}

/**
 * Guest is asking whether a 3rd / extra pet is allowed given the 2-pet max.
 * @param {string} message
 */
export function isPetOverMaxAsk(message = '') {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) return false;
  const mentionsPet = /\b(?:dogs?|pets?|pupp(?:y|ies)|cats?)\b/.test(lower);
  if (!mentionsPet) return false;
  if (
    /\b(?:2|two)[- ]dogs? max\b/.test(lower) ||
    /\bmax(?:imum)? (?:of )?(?:2|two) (?:dogs?|pets?)\b/.test(lower) ||
    /\b(?:2|two)[- ](?:dog|pet) (?:max|maximum|limit)\b/.test(lower) ||
    /\byour 2 dog max\b/.test(lower)
  ) {
    return true;
  }
  if (
    /\b(?:third|3rd|another|extra|additional) (?:dog|pet)\b/.test(lower) ||
    /\b(?:3|three) (?:dogs?|pets?)\b/.test(lower)
  ) {
    return true;
  }
  // "in the unlikely event that our very senior dog … will that be an issue?"
  if (isUnlikelyEventIdiom(lower) && /\b(?:issue|okay|ok|allowed|alright)\b/.test(lower)) {
    return true;
  }
  return false;
}
