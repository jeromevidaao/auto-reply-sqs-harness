import { BaseTool } from '../BaseTool.js';

/**
 * StayExtensionTool
 *
 * Detects requests from guests to extend (or shorten) their stay by full days:
 *   - "extend our stay by one day", "checkout on the 29th instead of the 28th"
 *   - "arrive one day earlier", "begin our stay one night earlier — on Thursday, 10/15"
 *
 * This is DISTINCT from LATE_CHECKOUT (a few hours on the *original* checkout day, e.g. "12pm instead of 10am").
 *
 * When detected:
 *   - Parses the intent + proposed new dates relative to context.checkIn / checkOut
 *   - Fetches the real calendar for the specific listing via HospitableClient.getPropertyCalendar
 *   - Reports exact availability for the extra night(s) so the agent + judge can be 100% accurate
 *   - Never fabricates "available" / "not available"
 *   - When free: suggests the guest submit an alteration request (Airbnb/Hospitable) for the dates
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

  /**
   * Shared detection regex — also used by agent pre-filters.
   * Covers Lilly-style later checkout AND Anna-style "begin stay one night earlier on 10/15".
   */
  static FULL_DAY_EXTENSION_RE =
    /(extend.*(stay|booking|reservation|night|day)|one more (day|night)|extra (day|night)|stay (one|an) (extra|more) (day|night)|checkout on the \d|check out on the \d|check-out on the \d|arriv(e|ing|al).*(one|a) (day|night) (early|earlier|before)|come (one|a) (day|night) (early|earlier)|change (my )?(checkout|check.out|departure|check out|check.?in|arrival) (date|to)|move checkout|push checkout|leave on the \d|through the \d|until the \d|begin (our |the |my )?stay.*(one|a) (night|day) earlier|start (our |the |my )?stay.*(one|a) (night|day) earlier|(one|a) (night|day) earlier|arrive.*(earlier|early).*(on|the|\d)|check.?in.*(one|a) (night|day) (early|earlier)|come in (one|a) (night|day) early|additional (evening|night)|open to (this|an earlier|arriving earlier))/i;

  static HOUR_ONLY_LATE_CHECKOUT_RE =
    /(late checkout|check out later|checkout later|a bit later|few hours|12\s*pm|1\s*pm|11\s*am|stay until (noon|1|12|midday)|leave at (12|1|noon))/i;

  static looksLikeFullDayExtension(message = '') {
    const msgLower = (message || '').toLowerCase();
    if (!StayExtensionTool.FULL_DAY_EXTENSION_RE.test(msgLower)) return false;
    // Hour-only late checkout is LATE_CHECKOUT, not full-day — unless guest also asks for earlier arrival / extra nights.
    if (StayExtensionTool.HOUR_ONLY_LATE_CHECKOUT_RE.test(msgLower)) {
      const alsoFullDayEarlierOrExtra =
        /(one|a) (night|day) earlier|begin (our |the )?stay|extra (day|night)|one more (day|night)|additional (evening|night)|extend/i.test(msgLower);
      if (!alsoFullDayEarlierOrExtra) return false;
    }
    return true;
  }

  async execute(input, context = {}) {
    const message = typeof input === 'string' ? input : (input?.message || input?.guestMessage || '');
    const msgLower = (message || '').toLowerCase();

    if (!StayExtensionTool.looksLikeFullDayExtension(message)) {
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
        suggestedResponseSnippet: "I'll check the calendar for those dates and get back to you shortly.",
        guestActionWhenAvailable: 'submit_alteration_request',
      };
    }

    // Infer the proposed new checkout (or checkin) date from message + current dates.
    const extension = this._parseProposedExtension(message, currentCheckIn, currentCheckOut);

    // Safety net for pure "one more night / extra night" requests (no bare day number spoken).
    // Ensures we still propose a concrete +1 using the booking's full date context (month/year).
    const lowerForOneMore = (message || '').toLowerCase();
    const looksLikeSimpleOneMore = /(one more|an extra|extra (day|night)|extend.*(by )?(one |a )?(day|night)|stay (one |an )?(extra|more)( night| day)?)/i.test(lowerForOneMore);
    if (!extension.proposedCheckOut && !extension.proposedCheckIn && currentCheckOut && looksLikeSimpleOneMore) {
      extension.proposedCheckOut = this._addDaysStr(currentCheckOut, 1);
      extension.type = 'later_checkout';
    }

    // Safety net: "one night earlier" / "begin stay earlier" without a parseable date → check-in - 1.
    const looksLikeSimpleOneEarlier =
      /(one|a) (night|day) earlier|begin (our |the |my )?stay.*(earlier|early)|start (our |the |my )?stay.*(earlier|early)|arrive (one|a) (night|day) early/i.test(lowerForOneMore);
    if (!extension.proposedCheckOut && !extension.proposedCheckIn && currentCheckIn && looksLikeSimpleOneEarlier) {
      extension.proposedCheckIn = this._addDaysStr(currentCheckIn, -1);
      extension.type = 'earlier_checkin';
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
        suggestedResponseSnippet: "I'll check the calendar for the dates you mentioned and let you know right away.",
        guestActionWhenAvailable: 'submit_alteration_request',
      };
    }

    // Fetch a safe window around the requested extra nights
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

    const shortUnit = this._shortUnitName(propertyName);
    const nightLabel = this._formatNightLabel(extraNights, extension);

    let suggestedResponseSnippet;
    if (!calendarChecked) {
      suggestedResponseSnippet = "I'll check our calendar for those dates and get back to you shortly.";
    } else if (allAvailable) {
      // Host policy: when free, confirm and ask guest to submit an alteration request (do not claim we already changed the booking).
      if (extension.type === 'earlier_checkin' && extension.proposedCheckIn) {
        suggestedResponseSnippet =
          `I checked the calendar for ${shortUnit} and ${nightLabel} looks available. ` +
          `Please submit an alteration request in Airbnb for the updated check-in date so we can review and confirm — happy to accommodate if the request comes through.`;
      } else {
        suggestedResponseSnippet =
          `I checked the calendar for ${shortUnit} and ${nightLabel} looks available. ` +
          `Please submit an alteration request in Airbnb for those dates so we can review and confirm.`;
      }
    } else {
      const bad = unavailableDates.map((d) => this._friendlyDate(d)).join(' / ');
      suggestedResponseSnippet =
        `I checked the calendar for ${shortUnit} and unfortunately ${bad} is not available — we already have another booking overlapping.`;
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
      suggestedResponseSnippet,
      guestActionWhenAvailable: 'submit_alteration_request',
    };
  }

  _shortUnitName(propertyName) {
    if (!propertyName) return 'the unit';
    // Prefer "53 Pine St #2" style from "53 Pine St #2 · 1875 West End Victorian | EV..."
    const beforeSep = String(propertyName).split(/[·|]/)[0].trim();
    return beforeSep || propertyName;
  }

  _friendlyDate(iso) {
    const d = String(iso || '').slice(0, 10);
    const parts = d.split('-');
    if (parts.length < 3) return d;
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }

  _formatNightLabel(extraNights, extension) {
    if (extension?.type === 'earlier_checkin' && extension.proposedCheckIn) {
      const d = extension.proposedCheckIn.slice(0, 10);
      return `the night of ${this._friendlyDate(d)}`;
    }
    if (extraNights.length === 1) {
      return `the night of ${this._friendlyDate(extraNights[0])}`;
    }
    return `those dates (${extraNights.map((d) => this._friendlyDate(d)).join(', ')})`;
  }

  _inferExtensionType(msgLower, currentCheckOut) {
    if (/arriv|check.?in|come|start|begin/.test(msgLower) && /(early|earlier|before|one (night|day)|night earlier)/.test(msgLower)) {
      return 'earlier_checkin';
    }
    if (/checkout|check out|check-out|depart|leave|extend|one more|extra (day|night)/.test(msgLower)) {
      return 'later_checkout';
    }
    return 'date_change';
  }

  _parseProposedExtension(message, currentCheckIn, currentCheckOut) {
    const msg = message || '';
    const lower = msg.toLowerCase();

    // Prefer explicit MM/DD or MM/DD/YYYY (Anna: "Thursday, 10/15")
    const slashMatch = msg.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    let slashMonth = null;
    let slashDay = null;
    let slashYear = null;
    if (slashMatch) {
      slashMonth = parseInt(slashMatch[1], 10);
      slashDay = parseInt(slashMatch[2], 10);
      if (slashMatch[3]) {
        slashYear = parseInt(slashMatch[3], 10);
        if (slashYear < 100) slashYear += 2000;
      }
    }

    // Bare day ordinals: "28th", "the 29th". Prefer the *target* date, not "instead of the 28th".
    // Lilly: "instead of checking out on 28th, we'd check out on the 29th" → proposed day 29.
    let proposedDay = null;
    let monthHint = null;
    if (!slashMatch) {
      const target = this._extractTargetDayOrdinal(msg, lower);
      if (target) {
        proposedDay = target.day;
        monthHint = target.monthHint;
      }
    }

    // Strong earlier signals win even if "pay for additional evening" also matches later-ish words.
    const strongEarlier =
      /begin (our |the |my )?stay|start (our |the |my )?stay|(one|a) (night|day) earlier|arriv(e|ing).*(early|earlier)|check.?in.*(early|earlier)/i.test(lower);

    const wantsOneMore = /(one more|an extra|extra (day|night)|extend.*(by )?(one |a )?(day|night)|stay (one |an )?(extra|more)( night| day)?)/i.test(lower);

    let type = 'later_checkout';
    let proposedCheckOut = null;
    let proposedCheckIn = null;

    if (strongEarlier) {
      type = 'earlier_checkin';
      const ref = currentCheckIn || currentCheckOut;
      if (slashMonth && slashDay && ref) {
        proposedCheckIn = this._resolveAbsoluteDate(ref, slashMonth, slashDay, slashYear, 'earlier');
      } else if (proposedDay && currentCheckIn) {
        proposedCheckIn = this._resolveProposedDate(currentCheckIn, proposedDay, monthHint, 'earlier');
      } else if (currentCheckIn && /(one|a) (night|day) earlier|one night earlier/.test(lower)) {
        proposedCheckIn = this._addDaysStr(currentCheckIn, -1);
      }
    } else {
      type = 'later_checkout';
      const ref = currentCheckOut || currentCheckIn;
      if (slashMonth && slashDay && ref) {
        proposedCheckOut = this._resolveAbsoluteDate(ref, slashMonth, slashDay, slashYear, 'later');
      } else if (proposedDay && currentCheckOut) {
        proposedCheckOut = this._resolveProposedDate(currentCheckOut, proposedDay, monthHint, 'later');
        // If guest said "check out on the 29th" and current checkout is already the 29th,
        // they usually mean +1 night (leave on the 30th) — Lilly-style night semantics.
        // When proposed resolves to exactly current checkout, bump +1 day.
        if (proposedCheckOut && currentCheckOut && proposedCheckOut.slice(0, 10) === currentCheckOut.slice(0, 10) && wantsOneMore) {
          proposedCheckOut = this._addDaysStr(currentCheckOut, 1);
        }
      } else if (currentCheckOut && wantsOneMore) {
        proposedCheckOut = this._addDaysStr(currentCheckOut, 1);
      }
    }

    // If still no proposed but "one more day/night" style, default to +1 on checkout.
    if (!proposedCheckOut && !proposedCheckIn && currentCheckOut && wantsOneMore && !strongEarlier) {
      proposedCheckOut = this._addDaysStr(currentCheckOut, 1);
      type = 'later_checkout';
    }

    // Final earlier fallback
    if (!proposedCheckOut && !proposedCheckIn && currentCheckIn && strongEarlier) {
      proposedCheckIn = this._addDaysStr(currentCheckIn, -1);
      type = 'earlier_checkin';
    }

    // Safety: for simple one-more-night later checkout, never invent multi-week extra ranges.
    // If parse produced a far-future proposedCheckOut but language is "one more day", force +1.
    if (
      type === 'later_checkout' &&
      wantsOneMore &&
      currentCheckOut &&
      proposedCheckOut
    ) {
      const daysOut = this._daysBetween(currentCheckOut, proposedCheckOut);
      if (daysOut > 3) {
        proposedCheckOut = this._addDaysStr(currentCheckOut, 1);
      }
    }

    return { type, proposedCheckOut, proposedCheckIn };
  }

  /**
   * Pick the intended target day from guest text.
   * Prefer phrases after "we'd check out on" / "to the" / last ordinal when "instead of" present.
   */
  _extractTargetDayOrdinal(msg, lower) {
    // Explicit target phrases first
    const targetRe =
      /(?:we(?:'d| would)|could (?:we|i)|check(?:ing)?\s*out|checkout|leave|depart|extend(?:ing)?|through|until|to the)\s+(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:of\s+)?(\w+))?/gi;
    let lastTarget = null;
    let m;
    while ((m = targetRe.exec(msg)) !== null) {
      // Skip "instead of checking out on 28th" — handled by collecting matches not under "instead of"
      const start = Math.max(0, m.index - 24);
      const prefix = msg.slice(start, m.index).toLowerCase();
      if (/instead of\s*$/.test(prefix) || /instead of check/.test(prefix + m[0].toLowerCase())) {
        continue;
      }
      lastTarget = { day: parseInt(m[1], 10), monthHint: m[2] || null };
    }
    if (lastTarget) return lastTarget;

    // All ordinals; if "instead of X ... Y", prefer the last ordinal
    const all = [];
    const allRe = /(\d{1,2})(?:st|nd|rd|th)(?:\s*(?:of\s+)?(\w+))?/gi;
    while ((m = allRe.exec(msg)) !== null) {
      all.push({ day: parseInt(m[1], 10), monthHint: m[2] || null, index: m.index });
    }
    if (all.length === 0) {
      // Bare "on 28" without st/nd/rd/th
      const bare = msg.match(/(?:on the |on |the |until |through |to )(\d{1,2})(?:\s*(?:of\s+)?(\w+))?/i);
      if (bare) return { day: parseInt(bare[1], 10), monthHint: bare[2] || null };
      return null;
    }
    if (/instead of/.test(lower) && all.length >= 2) {
      return all[all.length - 1];
    }
    return all[all.length - 1];
  }

  _daysBetween(fromStr, toStr) {
    const a = new Date(fromStr.slice(0, 10) + 'T00:00:00').getTime();
    const b = new Date(toStr.slice(0, 10) + 'T00:00:00').getTime();
    return Math.round((b - a) / (24 * 60 * 60 * 1000));
  }

  /**
   * Resolve MM/DD[/YYYY] against the booking reference date.
   * direction: 'earlier' | 'later' controls how we pick year/month when ambiguous.
   */
  _resolveAbsoluteDate(referenceDateStr, month, day, yearHint = null, direction = 'later') {
    if (!referenceDateStr || !month || !day) return null;
    const ref = new Date(referenceDateStr + 'T00:00:00');
    let year = yearHint || ref.getFullYear();

    let candidate = new Date(year, month - 1, day);
    const refTime = ref.getTime();

    if (direction === 'earlier') {
      // Prefer the occurrence on or before the reference (same year first).
      // If candidate is after ref (e.g. guest said 12/20 for a Jan stay), step back a year.
      while (candidate.getTime() > refTime) {
        year -= 1;
        candidate = new Date(year, month - 1, day);
      }
      // If still far in the past (> ~11 months), step forward one year only if that stays before/on ref... skip.
    } else {
      while (candidate.getTime() <= refTime) {
        year += 1;
        candidate = new Date(year, month - 1, day);
      }
    }

    const y = candidate.getFullYear();
    const m = String(candidate.getMonth() + 1).padStart(2, '0');
    const d = String(candidate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Resolve a bare day ordinal (e.g. "28th", "the 3rd") + optional month hint
   * into a full YYYY-MM-DD date, using the booking's reference date.
   * direction: 'earlier' | 'later'
   */
  _resolveProposedDate(referenceDateStr, day, monthHint = null, direction = 'later') {
    if (!referenceDateStr || !day) return null;

    const ref = new Date(referenceDateStr + 'T00:00:00');
    let year = ref.getFullYear();
    let month = ref.getMonth() + 1; // 1-12

    if (monthHint) {
      const hinted = this._monthNameToNum(monthHint);
      if (hinted) {
        if (direction === 'later' && hinted < month) {
          year += 1;
        } else if (direction === 'earlier' && hinted > month) {
          year -= 1;
        }
        month = hinted;
      }
    }

    let candidate = new Date(year, month - 1, day);
    const refTime = ref.getTime();

    if (direction === 'earlier') {
      // Move to previous month while candidate is still on/after reference check-in
      // (so "the 15th" with check-in 16th → same month 15th, not next month).
      let guard = 0;
      while (candidate.getTime() >= refTime && guard < 14) {
        candidate.setMonth(candidate.getMonth() - 1);
        candidate.setDate(day);
        guard += 1;
      }
    } else {
      let guard = 0;
      while (candidate.getTime() <= refTime && guard < 14) {
        candidate.setMonth(candidate.getMonth() + 1);
        candidate.setDate(day);
        guard += 1;
      }
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
      // Extra nights = each night from old checkout (inclusive) up to but not including new checkout.
      // Example: checkout 28th → 29th means guest stays the night of the 28th.
      let d = currentCheckOut.slice(0, 10);
      const end = extension.proposedCheckOut.slice(0, 10);
      while (d < end) {
        extra.push(d);
        d = this._addDaysStr(d, 1);
      }
    } else if (extension.type === 'earlier_checkin' && extension.proposedCheckIn && currentCheckIn) {
      // Extra nights = proposed check-in through the night before original check-in.
      let d = extension.proposedCheckIn.slice(0, 10);
      const end = currentCheckIn.slice(0, 10);
      while (d < end) {
        extra.push(d);
        d = this._addDaysStr(d, 1);
      }
    }

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
        // Hospitable day objects often use status.available boolean
        else if (entry.status && typeof entry.status === 'object') {
          if (entry.status.available === true) isAvail = true;
          else if (entry.status.available === false || entry.status.blocked === true) isAvail = false;
        }
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
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
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
