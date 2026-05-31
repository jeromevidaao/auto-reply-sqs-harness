/**
 * Normalizes a guest name that may come in formats like:
 *   - "Menghang(David)"
 *   - "David (Menghang)"
 *   - "Li Wei (Michael)"
 *
 * Goal: Avoid robotic repetition of the full "Chinese(English)" format every time.
 *
 * Strategy:
 * - If the name contains parentheses, extract both parts.
 * - Prefer the English name if it looks like a common Western name.
 * - Otherwise fall back to the first name.
 * - For very short conversations, it's okay to use the full name once.
 */

export function normalizeGuestName(rawName) {
  if (!rawName || typeof rawName !== 'string') {
    return { displayName: 'Guest', fullName: rawName || '' };
  }

  // Strip common Unicode bidirectional / directional formatting markers that Hospitable/Airbnb
  // sometimes wraps around guest names in webhooks (e.g. \u2068Menghang(David)\u2069).
  // These break the parentheses regex and produce ugly robotic display names.
  const stripped = rawName.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim();

  const trimmed = stripped;

  // Match patterns like "Menghang(David)" or "David (Menghang)"
  const parenMatch = trimmed.match(/^(.+?)\s*\((.+?)\)\s*$/);

  if (!parenMatch) {
    // No parentheses — use as-is
    return {
      displayName: trimmed.split(' ')[0], // first name only for natural feel
      fullName: trimmed,
      hasAlternativeName: false
    };
  }

  const part1 = parenMatch[1].trim();
  const part2 = parenMatch[2].trim();

  // Simple heuristic: if one part looks like a common Western name, prefer it
  const westernNames = /^(David|Michael|James|John|Robert|William|Richard|Charles|Joseph|Thomas|Christopher|Daniel|Matthew|Anthony|Mark|Steven|Paul|Andrew|Joshua|Kenneth|Kevin|Brian|George|Timothy|Ronald|Edward|Jason|Jeffrey|Ryan|Jacob|Gary|Nicholas|Eric|Jonathan|Stephen|Larry|Justin|Scott|Brandon|Benjamin|Samuel|Raymond|Gregory|Frank|Alexander|Patrick|Jack|Dennis|Jerry|Tyler|Aaron|Jose|Adam|Nathan|Henry|Douglas|Zachary|Peter|Kyle|Walter|Harold|Jeremy|Ethan|Carl|Keith|Roger|Gerald|Christian|Terry|Sean|Austin|Arthur|Lawrence|Jesse|Albert|Dylan|Harold|Arthur|Lawrence)$/i;

  let preferred = part1;
  let alternative = part2;

  if (westernNames.test(part2) && !westernNames.test(part1)) {
    preferred = part2;
    alternative = part1;
  } else if (westernNames.test(part1)) {
    preferred = part1;
    alternative = part2;
  } else {
    // If neither looks clearly Western, prefer the first part (usually the legal/Chinese name in their system)
    preferred = part1;
    alternative = part2;
  }

  return {
    displayName: preferred,
    fullName: trimmed,
    alternativeName: alternative,
    hasAlternativeName: true
  };
}

/**
 * Returns a natural way to address the guest in a message.
 * Tries to avoid robotic repetition of the full "Name(English)" format.
 */
export function getNaturalGuestAddress(rawName, previousUses = 0) {
  const normalized = normalizeGuestName(rawName);

  if (!normalized.hasAlternativeName) {
    return normalized.displayName;
  }

  // For the first use in a conversation, using the full name is sometimes okay
  // After that, strongly prefer just the natural name
  if (previousUses <= 1) {
    return normalized.fullName;
  }

  return normalized.displayName;
}
