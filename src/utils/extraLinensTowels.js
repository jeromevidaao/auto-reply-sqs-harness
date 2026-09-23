/**
 * Apt 2 / Apt 3 extra towels & linens — under the living-room sofa chaise (FRIHETEN-style; never name brand to guests).
 * Kenneth 2026-09-22: model invented linen closet / bathroom sink and offered
 * host delivery. Shared by agent policy + claimCheck.
 */

export const APT2_LISTING_ID = '114663c5-0709-4eff-a868-fa9ebd6ed42d';
export const APT3_LISTING_ID = '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd';

export const EXTRA_LINENS_TOWELS_FOLLOW_UP =
  'If you cannot find them, feel free to let us know.';

/** Correct Apt 2/3 storage guidance (sofa lift-up). */
export const CORRECT_SOFA_LOCATION_RE =
  /lift up|lift the|chaise|under the (?:living[- ]?room )?sofa|under the sofa|storage compartment|storage sofa|lid stays open/i;

/** Invented wrong places — never tell Apt 2/3 guests extras are here. */
export const WRONG_EXTRA_LINENS_LOCATION_RE =
  /linen closet|bathroom sink|under (?:the )?sink|under the bathroom|in the cabinets?|in (?:the )?drawers?|check (?:the )?cabinets?|check (?:the )?drawers?/i;

/** Premature host delivery on first ask when storage exists. */
export const PREMATURE_BRING_OVER_RE =
  /i(?:'|’)ll bring .{0,40}(?:right over|over right away|over shortly)|bring (?:extra |additional )?(?:bath )?towels? right over|bring additional sets right over/i;

export function isApt2OrApt3SofaLinensUnit(context = {}) {
  const id = String(context.listingId || context.listing_id || '');
  if (id === APT2_LISTING_ID || id === APT3_LISTING_ID) return true;
  const name = String(context.propertyName || context.listingName || '').toLowerCase();
  if (/\bapt\s*3\b|#3\b|unit\s*3\b|west end victorian.*3/.test(name)) return true;
  if (/\bapt\s*2\b|#2\b|unit\s*2\b|sunny downtown 2|sunny apt 2|1875 west end victorian/.test(name)) {
    return true;
  }
  return false;
}

/** Public CDN photo of chaise storage open (Apt 2/3 guest replies). */
export const APT23_CHAISE_STORAGE_IMAGE_URL =
  'https://www.cleaningbutton.com/images/guest-guides/apt23-chaise-storage.jpg';

/** Hospitable `images` URLs for Apt 2/3 extra-linens/towels replies. */
export function apt23ExtraLinensReplyImages(context = {}) {
  return isApt2OrApt3SofaLinensUnit(context) ? [APT23_CHAISE_STORAGE_IMAGE_URL] : [];
}

/**
 * In-stay ask for more / where towels or linens are.
 * Widened for Kenneth: "only 4 towel sets for 5 people" / "more bath towels".
 */
export function looksLikeInStayExtraLinensTowelsAsk(guestMessage = '') {
  const lower = String(guestMessage || '').toLowerCase();
  if (!lower.trim()) return false;

  const towelOrLinen =
    /\b(?:towels?|bath\s*towels?|linens?|sheets?|blankets?|pillows?|wash\s*cloths?)\b/.test(lower);
  if (!towelOrLinen) return false;

  const askCue =
    /\b(?:more|extra|additional|another|where|find|stored|available|are there|do you have|in the unit|under|need|could we get|can we get|only (?:have |got )?\d+|not enough|for \d+ people)\b/.test(
      lower
    );
  if (!askCue) return false;

  // Avoid pure pre-arrival amenity lists ("do you provide towels and toiletries?") —
  // those stay MISC; require more/extra/where/need or party-size shortfall.
  const inStayOrShortfall =
    /\b(?:more|extra|additional|another|where|find|need|could we get|can we get|only (?:have |got )?\d+|not enough|for \d+ (?:people|guests|of us)|in the (?:unit|apartment)|we(?:'|’)re here|checked in)\b/.test(
      lower
    ) ||
    /\b(?:more|extra|additional)\b.{0,40}\b(?:towels?|linens?)\b/.test(lower) ||
    /\b(?:towels?|linens?)\b.{0,40}\b(?:more|extra|additional|for \d+)\b/.test(lower);

  return inStayOrShortfall;
}

export function draftHasWrongExtraLinensLocation(draft = '') {
  return WRONG_EXTRA_LINENS_LOCATION_RE.test(String(draft || ''));
}

export function draftHasCorrectSofaLocation(draft = '') {
  return CORRECT_SOFA_LOCATION_RE.test(String(draft || ''));
}

export function draftHasPrematureBringOver(draft = '') {
  return PREMATURE_BRING_OVER_RE.test(String(draft || ''));
}

export function draftHasExtraLinensFollowUp(draft = '') {
  const lower = String(draft || '').toLowerCase();
  return (
    /let (?:us|me) know/.test(lower) ||
    /feel free/.test(lower) ||
    /cannot find|can't find/.test(lower)
  );
}

/**
 * Canonical guest-facing copy for Apt 2 / Apt 3 extra towels & linens.
 */
export function buildCanonicalExtraLinensTowelsReply(context = {}) {
  const rawName = context.guestDisplayName || context.guestName || '';
  const name = String(rawName).split(/[\s(]/)[0] || '';
  const body =
    "extra bath towels and linens are stored under the chaise of the living-room sofa (the long lounge section). " +
    "Lift the chaise seat up — the lid stays open — and the towels and linens are inside. " +
    EXTRA_LINENS_TOWELS_FOLLOW_UP;
  if (name) {
    return `${name}, ${body}`;
  }
  return body.charAt(0).toUpperCase() + body.slice(1);
}

/**
 * True when Apt 2/3 draft must be rewritten (wrong place, premature bring-over,
 * or missing sofa lift-up guidance).
 */
export function apt23ExtraLinensDraftNeedsRewrite(draft = '', context = {}) {
  if (!isApt2OrApt3SofaLinensUnit(context)) return false;
  const text = String(draft || '').trim();
  if (!text || text === 'none') return false;
  if (draftHasWrongExtraLinensLocation(text)) return true;
  if (draftHasPrematureBringOver(text)) return true;
  if (!draftHasCorrectSofaLocation(text)) return true;
  return false;
}
