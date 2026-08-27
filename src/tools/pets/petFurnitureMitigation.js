/**
 * Strong pet-furniture mitigation (PET_QUESTIONS).
 *
 * Elizabeth Apt 3 2026-08-27: guest said they cover all furniture with extra
 * sheets (dogs jump on beds at home) and offered to cancel. Auto sent
 * "the pet rule is firm" + Airbnb cancellation policy 475. Host position:
 * covering furniture with linens is fine; no need to cancel.
 */

export const PET_FURNITURE_MITIGATION_SNIPPET =
  'This is fine with us if you cover the furniture. No need to cancel — thanks for checking with us!';

/**
 * Guest is offering a strong mitigation for the no-pets-on-beds/sofas rule
 * (cover furniture/beds with linens/sheets) — not asking for extra linens
 * from us, and not checkout housekeeping.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isPetFurnitureMitigation(message = '') {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) return false;
  if (
    /pulled the linens|gathered all of the trash|officially checked out/.test(
      lower
    )
  ) {
    return false;
  }
  const coversFurniture =
    /\bcover(?:ing|s|ed)? (?:all )?(?:of )?(?:the )?(?:furniture|beds?|sofas?|couches?)\b/.test(
      lower
    ) ||
    /\b(?:sheets|linens) (?:on|over) (?:all )?(?:the )?(?:furniture|beds?|sofas?)\b/.test(
      lower
    ) ||
    /\b(?:extra sheets|extra linens).{0,120}\bcover/.test(lower);
  if (!coversFurniture) return false;
  return (
    /\b(?:dogs?|pets?|pupp(?:y|ies)|cats?|bed rule)\b/.test(lower) ||
    /\bcover(?:ing|s|ed)? (?:all )?(?:the )?furniture\b/.test(lower)
  );
}
