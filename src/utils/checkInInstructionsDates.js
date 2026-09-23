/**
 * Airbnb check-in / entry-instructions deferral dates.
 *
 * Proactive HE/Airbnb sends land 3 calendar days before check-in
 * (America/New_York calendar). Reactive asks use the same send day.
 */

const MONTH_DAY_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * @param {string} ymd YYYY-MM-DD
 * @param {number} deltaDays
 * @returns {string|null}
 */
export function addCalendarDaysYmd(ymd, deltaDays) {
  const raw = String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  // Noon UTC so calendar-day math is stable across DST.
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(deltaDays || 0));
  return dt.toISOString().slice(0, 10);
}

/**
 * Check-in minus 3 calendar days → day we send entry/check-in instructions.
 * @param {string} checkInYmd
 * @returns {string|null}
 */
export function checkInInstructionsSendYmd(checkInYmd) {
  return addCalendarDaysYmd(String(checkInYmd || '').slice(0, 10), -3);
}

/**
 * Guest-friendly "September 30" (no year).
 * @param {string} ymd
 * @returns {string}
 */
export function formatGuestFriendlyMonthDay(ymd) {
  const raw = String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (Number.isNaN(dt.getTime())) return '';
  return MONTH_DAY_FMT.format(dt);
}

/**
 * Whole calendar days from `fromYmd` to `toYmd` (to - from).
 * @param {string} fromYmd
 * @param {string} toYmd
 * @returns {number|null}
 */
export function calendarDaysBetweenYmd(fromYmd, toYmd) {
  const a = String(fromYmd || '').slice(0, 10);
  const b = String(toYmd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const aDt = Date.UTC(ay, am - 1, ad, 12, 0, 0);
  const bDt = Date.UTC(by, bm - 1, bd, 12, 0, 0);
  return Math.round((bDt - aDt) / (1000 * 60 * 60 * 24));
}

/**
 * @param {object} context
 * @returns {{
 *   checkInYmd: string|null,
 *   todayYmd: string|null,
 *   sendYmd: string|null,
 *   sendLabel: string,
 *   daysUntilCheckIn: number|null,
 *   shouldDefer: boolean
 * }}
 */
export function resolveCheckInInstructionsTiming(context = {}) {
  const checkInYmd = String(context.checkIn || context.check_in || '')
    .trim()
    .slice(0, 10);
  const todayYmd = String(
    context.asOfDate || context.simulatedToday || context.today || ''
  )
    .trim()
    .slice(0, 10);
  const sendYmd = /^\d{4}-\d{2}-\d{2}$/.test(checkInYmd)
    ? checkInInstructionsSendYmd(checkInYmd)
    : null;
  const daysUntilCheckIn =
    /^\d{4}-\d{2}-\d{2}$/.test(checkInYmd) && /^\d{4}-\d{2}-\d{2}$/.test(todayYmd)
      ? calendarDaysBetweenYmd(todayYmd, checkInYmd)
      : null;
  // Defer only when the 3-day send day is still in the future (daysUntil > 3).
  const shouldDefer = daysUntilCheckIn != null && daysUntilCheckIn > 3;
  return {
    checkInYmd: /^\d{4}-\d{2}-\d{2}$/.test(checkInYmd) ? checkInYmd : null,
    todayYmd: /^\d{4}-\d{2}-\d{2}$/.test(todayYmd) ? todayYmd : null,
    sendYmd,
    sendLabel: sendYmd ? formatGuestFriendlyMonthDay(sendYmd) : '',
    daysUntilCheckIn,
    shouldDefer,
  };
}
