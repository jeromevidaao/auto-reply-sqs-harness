/**
 * Simple cleaning issue detector.
 * Looks for common phrases guests use when they noticed cleaning problems after checkout.
 *
 * Returns structured info if a cleaning complaint is detected.
 */
export function detectCleaningIssue(guestMessage, context = {}) {
  if (!guestMessage || typeof guestMessage !== 'string') {
    return { detected: false };
  }

  const text = guestMessage.toLowerCase();

  // Keywords and phrases that usually indicate a cleaning complaint
  const cleaningPatterns = [
    'hair in the shower',
    'stained',
    'dirty',
    'not clean',
    'cleaning',
    'smells like',
    'dust',
    'ceiling tile',
    'ceiling tiles',
    'bathroom was dirty',
    'kitchen was dirty',
    'sheets were dirty',
    'towels were dirty',
    'didn’t clean',
    'wasn’t cleaned',
    'left hair',
    'found hair',
  ];

  const matched = cleaningPatterns.find(pattern => text.includes(pattern));

  if (!matched) {
    return { detected: false };
  }

  // Try to extract a short summary of the complaint
  let summary = `Guest mentioned a cleaning issue related to "${matched}".`;

  // Look for more context around the matched phrase
  const matchIndex = text.indexOf(matched);
  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(text.length, matchIndex + matched.length + 120);
  const contextSnippet = guestMessage.substring(start, end).trim();

  return {
    detected: true,
    type: 'cleaning',
    matchedPhrase: matched,
    summary,
    contextSnippet,
    fullMessage: guestMessage,
    reservation: {
      id: context.reservationId || context.id || null,
      guestName: context.guestName || null,
      checkIn: context.checkIn || null,
      checkOut: context.checkOut || null,
      propertyName: context.propertyName || null,
      listingId: context.listingId || null,
    }
  };
}
