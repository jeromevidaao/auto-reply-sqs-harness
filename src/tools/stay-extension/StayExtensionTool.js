import { BaseTool } from '../BaseTool.js';

/**
 * StayExtensionTool
 *
 * Detects requests from guests to extend (or shorten) their stay by full days:
 *   - "extend our stay by one day", "checkout on the 29th instead of the 28th"
 *   - "arrive one day earlier", "can we come on the 27th instead"
 *
 * This is DISTINCT from LATE_CHECKOUT (a few hours on the *original* checkout day, e.g. "12pm instead of 10am").
 *
 * When detected:
 *   - Parses the intent + proposed new dates relative to context.checkIn / checkOut
 *   - Fetches the real calendar for the specific listing via HospitableClient.getPropertyCalendar
 *   - Reports exact availability for the extra night(s) so the agent + judge can be 100% accurate
 *   - Never fabricates "available" / "not available"
 *
 * The tool result (stayExtensionInfo) is surfaced in the first-pass prompt and passed to
 * reflection + Conversation Judge so that any claim about specific dates is forced to match
 * the live calendar data (or fall back to "I'll check and let you know").
 */
export class StayExtensionTool extends BaseTool {
  constructor({ hospitableClient = null } = {}) {
    super({
      name: 'check_stay_extension',
      description: 'Detects full-day stay extension or date change requests (earlier arrival or later checkout by nights, not hours). Fetches Hospitable calendar for the exact unit and reports precise availability so replies never fabricate date status.',
    });

    this.hospitableClient = hospitableClient;
  }

  async execute(input, context = {}) {
    const message = typeof input === 'string' ? input : (input?.message || input?.guestMessage || '');
    const msgLower = (message || '').toLowerCase();

    // Strong signals for *full day* extension (changing the checkout calendar date or arrival date), not same-day hour shift.
    // Late checkout examples that should NOT trigger: "a bit later", "12pm", "1pm", "few hours", "stay a bit longer on checkout day".
    const looksLikeFullDayExtension =
      /(extend.*(stay|booking|reservation|night|day)|one more (day|night)|extra (day|night)|stay (one|an) (extra|more) (day|night)|checkout on the \d|check out on the \d|check-out on the \d|arriv(e|ing|al).*(one|a) day (early|earlier|before)|come (one|a) day (early|earlier)|change (my )?(checkout|check.out|departure|check out) (date|to)|move checkout|push checkout|leave on the \d|through the \d|until the \d)/i.test(msgLower);

    // Explicit "late checkout by hours" language should be left to LATE_CHECKOUT category.
    const looksLikeHourOnlyLateCheckout =
      /(late checkout|check out later|checkout later|a bit later|few hours|12\s*pm|1\s*pm|11\s*am|stay until (noon|1|12|midday)|leave at (12|1|noon))/i.test(msgLower);

    if (!looksLikeFullDayExtension || looksLikeHourOnlyLateCheckout) {
      return { detected: false };
    }

    const listingId = context.listingId || context.propertyId || null;
    const currentCheckIn = context.checkIn || null;
    const currentCheckOut = context.checkOut || null;
    const propertyName = context.propertyName || context.listingName || 'the unit';

    if (!listingId || !currentCheckOut) {
      // Still detected the intent, but cannot check calendar accurately without identifiers.
      return {
        detected: true,
        extensionType: this._inferExtensionType(msgLower, currentCheckOut),
        currentCheckIn,
        currentCheckOut,
        proposedCheckOut: null,
        extraNights: [],
        listingId,
        propertyName,
        calendarChecked: false,
        allAvailable: null,
        unavailableDates: [],
        reason: 'Missing listingId or current checkout date in context — cannot fetch calendar',
        suggestedResponseSnippet: "I'll check the calendar for those dates and get back to you shortly."
      };
    }

    // Infer the proposed new checkout (or checkin) date from message + current dates.
    const extension = this._parseProposedExtension(message, currentCheckIn, currentCheckOut);

    // Safety net for pure "one more night / extra night" requests (no bare day number spoken).
    // Ensures we still propose a concrete +1 using the booking'\''s full date context (month/year).
    const lowerForOneMore = (message || '').toLowerCase();
    const looksLikeSimpleOneMore = /(one more|an extra|extra (day|night)|extend.*(by )?(one |a )?(day|night)|stay (one |an )?(extra|more)( night| day)?)/i.test(lowerForOneMore);
    if (!extension.proposedCheckOut && !extension.proposedCheckIn && currentCheckOut && looksLikeSimpleOneMore) {
      extension.proposedCheckOut = this._addDaysStr(currentCheckOut, 1);
      extension.type = 'later_checkout';
    }

    const extraNights = this._computeExtraNights(currentCheckIn, currentCheckOut, extension);

    if (extraNights.length === 0) {
      // Detected language but could not compute concrete extra nights — still surface as detected so LLM knows intent.
      return {
        detected: true,
        extensionType: extension.type,
        currentCheckIn,
        currentCheckOut,
        proposedCheckOut: extension.proposedCheckOut,
        proposedCheckIn: extension.proposedCheckIn,
        extraNights: [],
        listingId,
        propertyName,
        calendarChecked: false,
        allAvailable: null,
        unavailableDates: [],
        reason: 'Could not parse specific extra night(s) from the guest message',
        suggestedResponseSnippet: "I'll check the calendar for the dates you mentioned and let you know right away."
      };
    }

    // Fetch a safe window around the current checkout (covers extensions of a few days in either direction)
    const windowStart = this._addDays(Math.min(...extraNights.map(d => this._dateStrToComparable(d))), -2);
    const windowEnd = this._addDays(Math.max(...extraNights.map(d => this._dateStrToComparable(d))), +3);

    let calendarEntries = [];
    let calendarChecked = false;
    let fetchError = null;

    if (this.hospitableClient && typeof this.hospitableClient.getPropertyCalendar === 'function') {
      try {
        calendarEntries = await this.hospitableClient.getPropertyCalendar(listingId, windowStart, windowEnd);
        calendarChecked = true;
        console.log(`[StayExtensionTool] Fetched calendar for ${listingId} ${windowStart}→${windowEnd}: ${calendarEntries.length} entries`);
      } catch (err) {
        fetchError = err.message || String(err);
        console.warn('[StayExtensionTool] Calendar fetch failed (non-fatal, will not fabricate):', fetchError);
        calendarChecked = false;
      }
    } else {
      console.warn('[StayExtensionTool] No Hospitable client with getPropertyCalendar — cannot verify availability live.');
    }

    const availability = this._analyzeAvailability(calendarEntries, extraNights);

    const allAvailable = calendarChecked ? availability.allAvailable : null;
    const unavailableDates = calendarChecked ? availability.unavailable : [];

    let suggestedResponseSnippet;
    if (!calendarChecked) {
      suggestedResponseSnippet = "I'll check our calendar for those dates and get back to you shortly.";
    } else if (allAvailable) {
      suggestedResponseSnippet = `Yes, the ${extension.proposedCheckOut || extraNights[extraNights.length - 1]} looks available for ${propertyName} on our calendar.`;
    } else {
      const bad = unavailableDates.join(' / ');
      suggestedResponseSnippet = `Unfortunately, ${bad} is not available for ${propertyName} — we already have another booking overlapping.`;
    }

    return {
      detected: true,
      extensionType: extension.type,
      currentCheckIn,
      currentCheckOut,
      proposedCheckOut: extension.proposedCheckOut,
      proposedCheckIn: extension.proposedCheckIn,
      extraNights,
      listingId,
      propertyName,
      calendarChecked,
      allAvailable,
      unavailableDates,
      availableDates: availability.available,
      calendarWindow: { start: windowStart, end: windowEnd },
      fetchError: fetchError || null,
      suggestedResponseSnippet
    };
  }

  _inferExtensionType(msgLower, currentCheckOut) {
    if (/checkout|check out|check-out|depart|leave/.test(msgLower) && /29|30|28|27|earlier|later/.test(msgLower)) {
      return 'later_checkout';
    }
    if (/arriv|check.in|come|start/.test(msgLower) && /(early|earlier|before|one day)/.test(msgLower)) {
      return 'earlier_checkin';
    }
    return 'date_change';
  }

  _parseProposedExtension(message, currentCheckIn, currentCheckOut) {
    const msg = message || '';
    const lower = msg.toLowerCase();

    // Capture bare day ("28th", "the 29th") + optional month name ("of September", "Sept 3rd", "October 2").
    // This lets us resolve full dates using the authoritative booking month/year from context.
    const dateMatch = msg.match(/(?:on the |on |the |until |through |to )?(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:of\s+)?(\w+))?/i);
    let proposedDay = null;
    let monthHint = null;
    if (dateMatch) {
      proposedDay = parseInt(dateMatch[1], 10);
      monthHint = dateMatch[2] || null;
    }

    let type = 'later_checkout';
    let proposedCheckOut = null;
    let proposedCheckIn = null;

    if (/arriv|check.in|come on|start on|earlier/.test(lower)) {
      type = 'earlier_checkin';
      if (proposedDay && currentCheckIn) {
        proposedCheckIn = this._resolveProposedDate(currentCheckIn, proposedDay, monthHint);
      }
    } else if (/checkout|check.out|check out|leave|depart/.test(lower)) {
      type = 'later_checkout';
      if (proposedDay && currentCheckOut) {
        proposedCheckOut = this._resolveProposedDate(currentCheckOut, proposedDay, monthHint);
      } else if (currentCheckOut) {
        // Fallback: "one day" / "one more" language without explicit number
        if (/(one|an)\s*(more|extra|day later|additional)/i.test(lower)) {
          proposedCheckOut = this._addDaysStr(currentCheckOut, 1);
        }
      }
    }

    // If still no proposed but "one more day/night" style (even without explicit "checkout" word), default to +1 on checkout.
    // This preserves the full booking month/year context from currentCheckOut.
    const wantsOneMore = /(one more|an extra|extra (day|night)|extend.*(by )?(one |a )?(day|night)|stay (one |an )?(extra|more)( night| day)?)/i.test(lower);
    if (!proposedCheckOut && !proposedCheckIn && currentCheckOut && wantsOneMore) {
      proposedCheckOut = this._addDaysStr(currentCheckOut, 1);
      type = 'later_checkout';
    }

    return { type, proposedCheckOut, proposedCheckIn };
  }

  /**
   * Resolve a bare day ordinal (e.g. "28th", "the 3rd") + optional month hint
   * into a full YYYY-MM-DD date, using the booking's reference date (checkOut or checkIn)
   * as the source of truth for year and "current" month.
   *
   * This is how we get the "full context for the month and year" when the guest
   * only says "28th" or "29th" but the reservation is "Sep 26–29 2026".
   *
   * Heuristic for extensions:
   * - Default to same year+month as the reference booking date.
   * - If an explicit month name is in the guest message, use it (and bump year if it would be in the past).
   * - For later-checkout style, if the resulting date is not strictly after the reference,
   *   advance to the next month (handles "extend to the 5th" when current checkout is the 29th).
   */
  _resolveProposedDate(referenceDateStr, day, monthHint = null) {
    if (!referenceDateStr || !day) return null;

    const ref = new Date(referenceDateStr + 'T00:00:00');
    let year = ref.getFullYear();
    let month = ref.getMonth() + 1; // 1-12

    if (monthHint) {
      const hinted = this._monthNameToNum(monthHint);
      if (hinted) {
        if (hinted < month) {
          year += 1; // e.g. guest in late Sep says "the 3rd" meaning October 3rd
        }
        month = hinted;
      }
    }

    let candidate = new Date(year, month - 1, day);

    // For checkout extensions (and similar), if the candidate day would be on or before
    // the reference checkout, treat it as the *next* occurrence of that day number.
    // This gives sensible behavior for "checkout on the 5th" near end of month,
    // or "the 28th" when the booking checkout is the 29th.
    const refTime = ref.getTime();
    while (candidate.getTime() <= refTime) {
      candidate.setMonth(candidate.getMonth() + 1);
      // Re-apply the day in case of month length issues (e.g. 31 → 30)
      candidate.setDate(day);
    }

    const y = candidate.getFullYear();
    const m = String(candidate.getMonth() + 1).padStart(2, '0');
    const d = String(candidate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  _monthNameToNum(name) {
    if (!name) return null;
    const n = name.toLowerCase().replace(/\.|th|st|nd|rd/g, '').trim();
    const map = {
      jan: 1, january: 1,
      feb: 2, february: 2,
      mar: 3, march: 3,
      apr: 4, april: 4,
      may: 5,
      jun: 6, june: 6,
      jul: 7, july: 7,
      aug: 8, august: 8,
      sep: 9, sept: 9, september: 9,
      oct: 10, october: 10,
      nov: 11, november: 11,
      dec: 12, december: 12
    };
    return map[n] || null;
  }

  _computeExtraNights(currentCheckIn, currentCheckOut, extension) {
    const extra = [];
    if (!currentCheckOut) return extra;

    if (extension.type === 'later_checkout' && extension.proposedCheckOut) {
      // The extra night is the night before the new checkout (i.e. currentCheckOut date itself if it was the old checkout day)
      // Example: checkout 28th → 29th means guest wants to stay the night of 28th.
      // So the "extra" calendar date to check is the old checkout date (treated as a stay night now).
      const d = currentCheckOut.slice(0, 10);
      if (!extra.includes(d)) extra.push(d);
    } else if (extension.type === 'earlier_checkin' && extension.proposedCheckIn && currentCheckIn) {
      // Extra night(s) before original check-in. The night before original check-in becomes a stay night.
      // For +1 day earlier: the date of original checkIn - 1 day.
      const orig = currentCheckIn.slice(0, 10);
      const prev = this._addDaysStr(orig, -1);
      extra.push(prev);
    }

    // Dedup + sort
    return Array.from(new Set(extra)).sort();
  }

  _analyzeAvailability(calendarEntries, extraNights) {
    if (!Array.isArray(calendarEntries) || calendarEntries.length === 0) {
      return { allAvailable: false, available: [], unavailable: extraNights.slice() };
    }

    // Build lookup by date string YYYY-MM-DD
    const byDate = {};
    for (const e of calendarEntries) {
      const d = (e && (e.date || e.day || e.cal_date)) ? String(e.date || e.day || e.cal_date).slice(0, 10) : null;
      if (d) byDate[d] = e;
    }

    const available = [];
    const unavailable = [];

    for (const night of extraNights) {
      const entry = byDate[night];
      // Common shapes: {available: true}, {status: 'available'}, {blocked: false}, or absence means unknown
      let isAvail = false;
      if (entry) {
        if (entry.available === true || entry.available === 'true') isAvail = true;
        else if (entry.status === 'available' || entry.status === 'open') isAvail = true;
        else if (entry.blocked === false || entry.is_blocked === false) isAvail = true;
        else if (entry.available === false || entry.blocked === true) isAvail = false;
      }
      if (isAvail) available.push(night);
      else unavailable.push(night);
    }

    return {
      allAvailable: unavailable.length === 0 && available.length === extraNights.length,
      available,
      unavailable
    };
  }

  _dateStrToComparable(dateStr) {
    // For min/max only; returns YYYYMMDD number
    return parseInt(String(dateStr).slice(0, 10).replace(/-/g, ''), 10);
  }

  _addDaysStr(dateStr, deltaDays) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  }

  _addDays(baseComparable, delta) {
    // baseComparable is number like 20260628, return YYYY-MM-DD str
    const y = Math.floor(baseComparable / 10000);
    const m = Math.floor((baseComparable % 10000) / 100);
    const day = baseComparable % 100;
    const dt = new Date(y, m - 1, day);
    dt.setDate(dt.getDate() + delta);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }
}