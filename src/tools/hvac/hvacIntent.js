/**
 * Guest HVAC intents that tools/policies act on (turn-off, etc.).
 */

export function guestAsksHostToTurnOff(guestMessage = '') {
  const m = String(guestMessage || '').toLowerCase();
  if (!m.trim()) return false;

  if (
    /are you able to turn (?:it|them|the .{0,40})off/.test(m) ||
    /can you (?:please )?(?:turn|shut|switch) (?:it|them).{0,24}off/.test(m) ||
    /would you (?:please )?(?:turn|shut|switch) (?:it|them).{0,24}off/.test(m) ||
    /(?:turn|shut) (?:it|them) off remotely/.test(m) ||
    /turn (?:it|them) off for (?:us|me)/.test(m)
  ) {
    return true;
  }

  const away = /\b(?:away|out|remotely)\b/.test(m);
  const leaveAsIs = /\bleave (?:it|them|as) (?:as )?is\b|\bleave (?:it|them) on\b/.test(m);
  const hvac = /\b(?:heat|heating|ac|a\/c|cool|cooling|air|off)\b/.test(m);
  if (away && leaveAsIs && hvac) return true;

  return false;
}
