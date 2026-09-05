/**
 * Guest-facing heat-pump head locations + mixed-mode rule.
 *
 * Mitsubishi cannot heat and cool different indoor heads at the same time.
 * Guest copy must name the rooms (living room / master bedroom / …), not
 * "heads" or Kumo labels like "Small BR".
 */

export const DEVICE_ROOM_NAME = {
  // Apt 1B
  'ff674e71-10cb-495c-9afb-959c434062aa': 'bedroom',
  'c221f8d8-cb87-4edf-9221-62f23759bb1a': 'kitchen',
  // Apt 2
  'a8a8d290-25ac-4f28-8c24-e2d6c3e7f3c5': 'living room',
  '3f8d9e08-5e9b-49f7-a793-7d68bed5ed39': 'master bedroom',
  '86e24a6a-0988-4f91-a258-8704f70a22f1': 'small bedroom',
  // Apt 3
  '7636c887-e946-4f55-9bd8-be9e0baa0bcd': 'living room',
  '18df3129-0790-490e-9545-cacd399f71b7': 'master bedroom',
  '30dc168d-698e-4218-b8d4-17d93cd15358': 'small bedroom',
};

const TWO_BED_ROOMS = ['living room', 'master bedroom', 'small bedroom'];
const STUDIO_ROOMS = ['bedroom', 'kitchen'];

const APT1B = { unitLabel: 'Apt 1B', rooms: STUDIO_ROOMS };
const APT2 = { unitLabel: 'Apt 2', rooms: TWO_BED_ROOMS };
const APT3 = { unitLabel: 'Apt 3', rooms: TWO_BED_ROOMS };

export const LISTING_HEADS = {
  'c899481f-2e5b-402d-80c4-3167fd824d96': APT1B,
  '20904545': APT1B,
  '114663c5-0709-4eff-a868-fa9ebd6ed42d': APT2,
  '20150380': APT2,
  '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd': APT3,
  '24259977': APT3,
};

export function headLayoutForListing(listingId) {
  if (!listingId) return null;
  return LISTING_HEADS[String(listingId)] || null;
}

export function guestRoomName(deviceId, fallback = null) {
  if (deviceId && DEVICE_ROOM_NAME[deviceId]) return DEVICE_ROOM_NAME[deviceId];
  return fallback || null;
}

export function formatRoomList(rooms = []) {
  const names = (rooms || []).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** One sentence guests can follow: all rooms same mode, or mixed will not work. */
export function mixedModeRule(rooms = []) {
  const where = rooms.length ? ` (${formatRoomList(rooms)})` : '';
  return (
    `All of the wall units${where} need to be on the same mode — either all heat or all cool. ` +
    `If one is on heat and another is on cool, they will not work.`
  );
}

/**
 * "The living room is on heat, and the master bedroom is on cool."
 * Falls back to empty string when modes/rooms are missing.
 */
export function describeLiveModes(units = []) {
  const byMode = new Map();
  for (const u of units || []) {
    const mode = String(u?.operationMode || '').toLowerCase();
    if (!mode) continue;
    const name = u.roomName || guestRoomName(u.deviceId) || null;
    if (!byMode.has(mode)) byMode.set(mode, []);
    byMode.get(mode).push(name || 'one unit');
  }
  if (byMode.size === 0) return '';
  const allNames = [...byMode.values()].flat();
  if (allNames.every((n) => n === 'one unit')) return '';
  const clauses = [];
  for (const [mode, names] of byMode.entries()) {
    const verb = names.length === 1 ? 'is' : 'are';
    clauses.push(`the ${formatRoomList(names)} ${verb} on ${mode}`);
  }
  if (clauses.length === 1) {
    return clauses[0].charAt(0).toUpperCase() + clauses[0].slice(1) + '.';
  }
  const last = clauses.pop();
  return `${clauses.join(', ')}, and ${last}.`.replace(/^the /, 'The ');
}
