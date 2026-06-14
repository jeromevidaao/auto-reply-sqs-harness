# Stay Extension / Date Change Requests (Full Days)

**Canonical category name(s)**: STAY_EXTENSION, STAY_EXTENSION_REQUEST, DATE_EXTENSION, STAY_DATE_CHANGE

**CRITICAL DISTINCTION FROM LATE_CHECKOUT**:
- LATE_CHECKOUT is ONLY for requests to leave a *few hours later on the original checkout day* (e.g. "can we check out at 12pm or 1pm instead of 10am?", "a bit later", "stay until noon on checkout day").
- STAY_EXTENSION is for requests to *change the checkout (or check-in) calendar date by one or more full nights* (e.g. "instead of checking out on the 28th, we'd check out on the 29th", "extend our stay by one day / one more night", "can we arrive one day earlier on the 27th?").
- When the guest message mentions changing the *date number* of checkout or using "one more day/night" / "extend by one day" language, classify as STAY_EXTENSION (not LATE_CHECKOUT). The late-checkout rules (strict 10AM + cleaning team) do **not** apply to full-day extensions.

**When to use**:
- Guest explicitly asks to move checkout to a later calendar date or arrival to an earlier calendar date, adding (or removing) full paid night(s).
- The request is about *availability of the specific unit on the new dates*, not just operational flexibility on checkout time.

**Response rules — 100% accuracy on availability is mandatory**:
- You **MUST** use the `stayExtensionInfo` result from the StayExtensionTool (visible in context / traces / prompt). This tool has already:
  - Detected the full-day intent.
  - Parsed the proposed new checkout/check-in.
  - Fetched the live calendar for the exact listingId/unit via Hospitable `/properties/{uuid}/calendar`.
  - Reported `calendarChecked`, `allAvailable`, `extraNights`, `unavailableDates`, etc.
- If `calendarChecked === true && allAvailable === true`:
  - Warmly confirm the specific dates look available on our calendar for *that unit*.
  - Example good language: "Good afternoon, Lilly, I checked the calendar for the Downtown Studio 1B and extending checkout to the 29th looks available. Would you like me to update the reservation for the extra night?"
  - Offer to proceed / ask for confirmation. Do **not** say "I've already changed the booking" (we report availability; the actual update is done by host or via Hospitable after confirmation).
- If `calendarChecked === true && allAvailable === false`:
  - Accurately state it is not available, naming the conflicting date(s) from `unavailableDates`.
  - Use phrasing close to: "Unfortunately, the 28th/29th is not available for that unit — we already have another booking overlapping those dates."
  - Be empathetic but direct. Offer alternatives only if you have real data (do not invent).
- If `calendarChecked === false` (fetch failed, no client, missing listingId/checkOut in context, or error):
  - **Never guess or fabricate**. Say exactly something like: "I'll check the calendar for the 29th and get back to you shortly." or "Let me look at availability for those dates and I'll message you right away."
  - Escalate internally if needed so the host can check quickly.
- Always surface the unit name (propertyName from context) when talking availability ("for the Studio 1B", "for Sunny Apt 2", etc.).
- Keep tone warm, concise, practical. Use the guest's natural name.

**Do not**:
- Ever reply with the strict LATE_CHECKOUT 10AM + "cleaning team needs to prepare the unit for the next guests" language when the guest is asking for a full extra night / date change. That is the wrong policy for this class of request.
- Fabricate "yes available" or "no, booked" without the tool result confirming it.
- Use vague "we'll see what we can do" without checking or offering to check.
- Promise the reservation is updated until it actually is.

**Judge / reflection backstop**:
- The Conversation Judge has an explicit rule against fabricating availability information. Any draft that claims specific dates are (or are not) available without `calendarChecked: true` + matching `allAvailable` / `unavailableDates` from the tool result **must** be REVISED (strip the claim, use accurate tool language or the safe "I'll check..." fallback) or REJECTED.
- This is the last-pass guarantee that we never send inaccurate calendar information to guests.

**Related categories**:
- LATE_CHECKOUT (only same-day hour extensions)
- EARLY_CHECKIN (for questions about arriving before 4pm on the *booked* check-in day, not changing the booked date)
- NEW_INQUIRY_WELCOME / pricing / misc (when the whole thread is pre-booking availability)

**Examples of correct classification**:
- Guest: "Is it possible to check out a bit later, maybe 12 or 1pm?" → LATE_CHECKOUT (hours on original day)
- Guest (Lilly case): "I'm wondering if I could extend our stay by one day -- instead of checking out on 28th, we'd check out on the 29th." → STAY_EXTENSION + use calendar tool result for the unit on the extra night.
- Guest: "Could we possibly arrive one day earlier?" (with current check-in date in context) → STAY_EXTENSION (earlier_checkin) + calendar check for the night before.

Be excellent and accurate. The tool + judge exist precisely so we never make up calendar facts.