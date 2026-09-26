/**
 * Dirty linen / checkout disposition — strip used sheets & towels, leave on bathroom floor.
 * Isabella 2026-09-26: guest asked "Are we to change the linens? Where should we put the dirty ones?"
 * Harness skipped; host Ruby replied manually. Distinct from EXTRA_LINENS_TOWELS (chaise find-more).
 */

export const DIRTY_LINEN_BATHROOM_FLOOR_PHRASE = 'bathroom floor';

/**
 * Guest asking whether to change/strip linens and/or where to put dirty/used ones.
 * Must NOT match Kenneth-style "more bath towels" / "where are extras" asks.
 */
export function looksLikeDirtyLinenDispositionAsk(guestMessage = '') {
  const lower = String(guestMessage || '').toLowerCase();
  if (!lower.trim()) return false;

  const linenCue = /\b(?:linens?|sheets?|towels?|bedding)\b/.test(lower);
  // "dirty ones" after linen context, or explicit dirty/used linen words
  const dirtyOnes = /\bdirty\s+ones?\b/.test(lower);
  if (!linenCue && !dirtyOnes) return false;

  const dirtyDisposition =
    /\bdirty\b/.test(lower) ||
    /\bused (?:sheets?|towels?|linens?|bedding)\b/.test(lower) ||
    /\bchange (?:the )?(?:linens?|sheets?|bedding|towels?)\b/.test(lower) ||
    /\bstrip\b/.test(lower) ||
    /\bput (?:the )?(?:dirty|used)\b/.test(lower) ||
    /\bleave (?:the )?(?:dirty|used)\b/.test(lower) ||
    /\bwhere (?:should|do|can) we put\b/.test(lower);

  return dirtyDisposition;
}

/** Draft already tells them bathroom floor (canonical) or bathroom + strip/dirty leave. */
export function draftHasDirtyLinenBathroomGuidance(draft = '') {
  const t = String(draft || '');
  if (!t.trim() || t.trim() === 'none') return false;
  if (/bathroom\s+floor/i.test(t)) return true;
  return (
    /\bbathroom\b/i.test(t) &&
    /(?:strip|dirty|used sheets|used towels|leave (?:them|the dirty|the used))/i.test(t)
  );
}

/**
 * Canonical guest-facing copy (product: bathroom floor; tone aligned with Ruby co-host).
 */
export function buildCanonicalDirtyLinenCheckoutReply(context = {}) {
  const rawName = context.guestDisplayName || context.guestName || '';
  const name = String(rawName).split(/[\s(]/)[0] || '';
  const body =
    'if you can strip the dirty linens that would be great — please leave the used sheets and towels on the bathroom floor. Thank you!';
  if (name) {
    return `Hi ${name}, ${body}`;
  }
  return `Hi, ${body}`;
}
