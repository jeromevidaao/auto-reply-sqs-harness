/**
 * Time-based greeting utilities (ported/adapted from old auto-reply-grok-sqs production logic).
 * All times are Eastern (America/New_York) as per host location and prior system.
 */

export function getTimeBasedGreeting(date = new Date()) {
  const nyHourStr = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false
  });
  const hour = parseInt(nyHourStr, 10) || 0;

  const dayOfWeek = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long'
  });
  const isFriday = dayOfWeek === 'Friday';

  let greeting;
  let additionalMessage = '';

  if (hour >= 5 && hour < 12) {
    greeting = 'Good morning';
  } else if (hour >= 12 && hour < 17) {
    greeting = 'Good afternoon';
  } else if (hour >= 17 && hour < 22) {
    greeting = 'Good evening';
  } else {
    greeting = 'Good evening';
    if (hour >= 22 || hour < 5) {
      additionalMessage = 'Have a good night';
    }
  }

  if (isFriday && !additionalMessage) {
    additionalMessage = 'Have a good weekend';
  }

  const currentTime = date.toLocaleString('en-US', { timeZone: 'America/New_York' });

  return {
    greeting,
    additionalMessage,
    currentTime,
    dayOfWeek,
    isFriday,
    hour
  };
}

/**
 * Compute NY calendar day key for "first message of the day" logic.
 */
function getNYDayKey(date) {
  return date.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

/**
 * Analyze provided host messages (from history or live fetch) to decide greeting behavior.
 * Mirrors the spirit of old checkRecentGreetings + hasRecentHostMessage but smarter for "first of day".
 *
 * Returns signals so the LLM (and early traces) can decide whether to start with time greeting + name.
 */
export function analyzeGreetingContext(messages = [], options = {}) {
  const now = new Date();
  const todayKey = getNYDayKey(now);

  const greetingPatterns = [
    /\bgood\s+(morning|afternoon|evening)\b/i,
    /\b(hi|hey|hello)\s+\w+[,!.\s]/i
  ];

  // Filter to host messages only
  const hostMessages = (messages || [])
    .filter(m => {
      const st = (m.sender_type || m.sender?.type || '').toLowerCase();
      return st === 'host';
    })
    .map(m => ({
      ...m,
      _time: new Date(m.created_at || m.timestamp || Date.now())
    }))
    .sort((a, b) => b._time - a._time);

  const lastHost = hostMessages[0] || null;
  const isFirstHostMessage = hostMessages.length === 0;

  let minutesSinceLastHost = null;
  let lastHostDayKey = null;
  let lastHostMessagePreview = null;
  if (lastHost) {
    minutesSinceLastHost = Math.round( (now - lastHost._time) / (1000 * 60) * 10 ) / 10;
    lastHostDayKey = getNYDayKey(lastHost._time);
    lastHostMessagePreview = (lastHost.body || '').substring(0, 160);
  }

  const lastHostWasPreviousDay = !!lastHostDayKey && lastHostDayKey !== todayKey;

  // Look for recent greeting (within recent window, e.g. 3 hours) to strongly suppress repeat
  const recentGreetingWindowMin = options.recentGreetingWindowMin || 180;
  const cutoff = new Date(now.getTime() - recentGreetingWindowMin * 60 * 1000);

  let hasRecentGreeting = false;
  let lastGreetingMessage = null;
  let lastGreetingTime = null;

  for (const m of hostMessages) {
    if (m._time < cutoff) break;
    const body = m.body || '';
    if (greetingPatterns.some(p => p.test(body))) {
      hasRecentGreeting = true;
      lastGreetingMessage = body;
      lastGreetingTime = m._time.toISOString();
      break;
    }
  }

  // SMART GREETING DECISION (per user requirements):
  // - Greet on very first host message in thread
  // - Greet if last host message was on a previous NY calendar day ("first of the day")
  // - Greet if last host was several hours ago (new conversation session)
  // - If recent back-and-forth (last host < ~90min and/or recent greeting seen), suppress formal greeting
  // - "every time" on new day / first message of day-ish
  let shouldUseGreeting = false;

  if (isFirstHostMessage) {
    shouldUseGreeting = true;
  } else if (lastHostWasPreviousDay) {
    shouldUseGreeting = true;
  } else if (minutesSinceLastHost !== null && minutesSinceLastHost > 360) { // >6h gap
    shouldUseGreeting = true;
  } else if (!hasRecentGreeting && minutesSinceLastHost !== null && minutesSinceLastHost > 120) { // 2h gap, no greeting in recent
    shouldUseGreeting = true;
  }

  // Hard suppression for very recent host activity (rapid back-and-forth) — only for actual past recent messages
  if (minutesSinceLastHost !== null && minutesSinceLastHost > 0 && minutesSinceLastHost < 25 && !isFirstHostMessage) {
    shouldUseGreeting = false;
  }

  // If we literally just sent a greeting-style message very recently (same session), suppress repeat
  // But do NOT suppress across day boundaries (previous day greeting should not prevent today's greeting)
  if (hasRecentGreeting && minutesSinceLastHost !== null && minutesSinceLastHost > 0 && minutesSinceLastHost < 45 && !lastHostWasPreviousDay) {
    shouldUseGreeting = false;
  }

  // Also prepare guest messages for lag defense (filter + time normalize, sort newest first like hosts)
  const guestMessages = (messages || [])
    .filter(m => {
      const st = (m.sender_type || m.sender?.type || '').toLowerCase();
      return st === 'guest';
    })
    .map(m => ({
      ...m,
      _time: new Date(m.created_at || m.timestamp || Date.now())
    }))
    .sort((a, b) => b._time - a._time);

  // LAG / EVENTUAL CONSISTENCY DEFENSE for own recent sends not yet reflected in /messages list:
  // If NO host messages are visible yet (isFirstHostMessage), but we see 2+ guest messages clustered
  // within a short window (<30min span between oldest and newest visible guest), this is likely a
  // rapid back-and-forth where our intervening host reply (e.g. the first "Good morning") has not
  // yet appeared in the live history fetch due to propagation lag. Suppress greeting on this
  // processing to avoid repeating "Good morning" on the 5:52 follow-up after 5:51 send (Amy case).
  // A true first-host (only a single guest msg seen so far, no prior host) will still greet.
  if (hostMessages.length === 0 && guestMessages.length >= 2) {
    const oldestG = guestMessages[guestMessages.length - 1];
    const newestG = guestMessages[0];
    const spanMin = (newestG._time - oldestG._time) / (1000 * 60);
    if (spanMin >= 0 && spanMin < 30) {
      shouldUseGreeting = false;
    }
  }

  return {
    isFirstHostMessage,
    lastHostWasPreviousDay,
    minutesSinceLastHost,
    hasRecentGreeting,
    lastGreetingMessage,
    lastGreetingTime,
    shouldUseGreeting,
    lastHostDayKey,
    todayKey,
    lastHostMessagePreview,
    numHostMessages: hostMessages.length,
    numGuestMessages: guestMessages.length
  };
}

/**
 * Convenience: given a context (with optional conversationHistory) and optional live messages,
 * produce the combined greeting signals + time greeting.
 */
export function buildGreetingSignals({ conversationHistory = [], liveHostMessages = null, options = {} } = {}) {
  const timeInfo = getTimeBasedGreeting();

  const messagesToUse = liveHostMessages && liveHostMessages.length > 0
    ? liveHostMessages
    : conversationHistory;

  const analysis = analyzeGreetingContext(messagesToUse, options);

  return {
    timeBasedGreeting: timeInfo.greeting,
    additionalMessage: timeInfo.additionalMessage,
    currentNYTime: timeInfo.currentTime,
    dayOfWeek: timeInfo.dayOfWeek,
    ...analysis
  };
}
