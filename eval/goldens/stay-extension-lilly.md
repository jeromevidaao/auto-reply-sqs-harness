# Golden: Stay Extension Request (Full Day Date Change) — Lilly

**Scenario**: Lilly asks to extend checkout from the 28th to the 29th (one extra night / calendar date change). This is the canonical production incident where the agent wrongly treated a full-day extension as a same-day "late checkout" and replied with the strict 10AM + cleaning team language about the 29th.

**Root cause of the bug (before fix)**:
- No distinction between "a few hours later on checkout day" (LATE_CHECKOUT, firm 10AM) vs. "change the checkout date by a full day / add a night" (STAY_EXTENSION).
- No calendar tool usage for the specific unit.
- Result: fabricated/wrong policy answer that made no sense for the actual request.

**Approved ideal behavior**:
- Correctly classify as STAY_EXTENSION (or STAY_EXTENSION_REQUEST).
- Use the stayExtensionTool result (pre-seeded in the scenario for deterministic eval, live in prod via HospitableClient.getPropertyCalendar + listingId).
- Report availability 100% accurately from the tool:
  - In this seeded case: calendarChecked=true, allAvailable=false, unavailableDates includes the extra night → reply must say the dates are not available for the unit, using the property name.
- Never use LATE_CHECKOUT 10AM/cleaning phrasing.
- Warm, concise, practical. Use natural name.
- If the tool had said available, the reply would confirm "looks available on our calendar for 53 Pine St #3" (or the unit name from context) and ask if they want the update.

**Rubric requirements** (enforced by eval runner + judge):
- expectedCategory: STAY_EXTENSION (or array containing it)
- shouldReply: true
- forbiddenPhrases: the old late-checkout 10AM + cleaning team language + any "late checkout on the 29th" phrasing
- requiredPhrases: must mention having "checked" the "calendar", state "not available", and name the unit using "53 Pine St #3" (from the seeded tool result and context.propertyName) so the accuracy grounding is visible.

**Example of a good reply for this seeded (unavailable) case**:
Good afternoon, Lilly, thanks for asking about extending the stay. I checked the calendar for 53 Pine St #3 and unfortunately the 29th is not available — we already have another booking overlapping. Let me know if you'd like me to look at other options.

(The exact wording can vary naturally as long as the required accuracy elements and forbidden phrases are satisfied; the judge will also enforce the tool match.)

**Notes for future regressions**:
- The scenario now uses the real September 2026 stay dates from the user's example ("Sep 26 – 29 · 3 nights 53 Pine St #3") so the date resolution logic (anchoring bare "28th"/"29th" to the booking's month/year + wrap heuristic) can be exercised in spirit.
- Adding a similar scenario with allAvailable=true (seeded) + required "looks available" / "checked the calendar" would also be valuable.
- The Conversation Judge rule 4b + the CRITICAL block in _buildUserPrompt (agent.js) + the tool itself (with improved _resolveProposedDate) are the multi-layer defense so we never send inaccurate date availability to guests.
- This scenario + golden + the new stay-extension.md + updated late-checkout.md lock the distinction the user requested. We now also resolve bare ordinals using the full booking context (checkOut month/year) instead of naive same-month prefix.