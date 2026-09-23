/**
 * Portland ME outdoor temp → heat vs cool for mixed-mode auto-fix.
 * Open-Meteo, no API key. Threshold documented + TDD'd: ≤62°F → heat, else cool.
 */

export const PORTLAND_ME_LAT = 43.6591;
export const PORTLAND_ME_LON = -70.2568;
/** Outdoor °F at or below this → heat; above → cool. */
export const OUTDOOR_HEAT_MAX_F = 62;

/**
 * @param {number|null|undefined} tempF
 * @returns {{mode: 'heat'|'cool'|null, outdoorTempF: number|null, reason: string}}
 */
export function decideHvacModeFromOutdoorF(tempF) {
  if (tempF == null || !Number.isFinite(Number(tempF))) {
    return { mode: null, outdoorTempF: null, reason: 'missing_temp' };
  }
  const t = Math.round(Number(tempF) * 10) / 10;
  if (t <= OUTDOOR_HEAT_MAX_F) {
    return { mode: 'heat', outdoorTempF: t, reason: 'outdoor_at_or_below_threshold' };
  }
  return { mode: 'cool', outdoorTempF: t, reason: 'outdoor_above_threshold' };
}

/**
 * Fetch current Portland ME outdoor temperature (°F) via Open-Meteo.
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchPortlandOutdoorTempF(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchPortlandOutdoorTempF: fetch is not available');
  }
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${PORTLAND_ME_LAT}` +
    `&longitude=${PORTLAND_ME_LON}&current=temperature_2m` +
    `&temperature_unit=fahrenheit&timezone=America%2FNew_York`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout?.(8000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  const t = data?.current?.temperature_2m;
  if (t == null || !Number.isFinite(Number(t))) {
    throw new Error('Open-Meteo missing current.temperature_2m');
  }
  return Number(t);
}

/**
 * Guest-facing auto-fix sentence listing rooms + mode + outdoor °F.
 */
export function buildOutdoorAutoFixSnippet({
  guestName = null,
  rooms = [],
  mode,
  outdoorTempF = null,
} = {}) {
  const hi = guestName ? `${guestName}, ` : '';
  const roomList = formatRooms(rooms);
  const where = roomList
    ? rooms.length === 2
      ? `both the ${roomList}`
      : `the ${roomList}`
    : 'all of the wall units';
  const outdoorBit =
    outdoorTempF != null && Number.isFinite(Number(outdoorTempF))
      ? ` based on the outdoor temperature (${Math.round(Number(outdoorTempF))}°F)`
      : ' based on the outdoor temperature';
  return (
    `${hi}I fixed the heat and AC for you. I set ${where} to ${mode}${outdoorBit} — they should start working now. ` +
    `All of the wall units need to stay on the same mode — either all heat or all cool — or they will not work. ` +
    `You can still pick a different temperature in each room with the remotes on the wall.`
  ).replace(/\s+/g, ' ').trim();
}

function formatRooms(rooms = []) {
  const names = (rooms || []).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

export default {
  OUTDOOR_HEAT_MAX_F,
  decideHvacModeFromOutdoorF,
  fetchPortlandOutdoorTempF,
  buildOutdoorAutoFixSnippet,
};
