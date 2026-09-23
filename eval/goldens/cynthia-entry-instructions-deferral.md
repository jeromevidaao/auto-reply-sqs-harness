# Golden: Cynthia — entry / check-in instructions deferral (name the send date)

**Scenario**: Cynthia (Downtown Studio / 1B) asks how to get into the unit with check-in October 3 and today ~September 23 (>3 days out).

**Production miss**: Auto-replied "I'll send the entry instructions before you arrive" with no concrete date.

**Approved ideal behavior**:
- Classify as `CHECK_IN_INSTRUCTIONS` (optionally with `THANK_YOU_MESSAGE`).
- Defer with the **3-day send day**: check-in minus 3 calendar days → **September 30**.
- Must say **on September 30** (or September 30th) and mention **3 days**.
- Do not dump door codes / full arrival guide this early.
- Sample: "Cynthia — you're welcome. You're all set for October 3rd. I'll send the check-in instructions on September 30 (3 days before your arrival) so you have clear steps for getting into the unit."

**Rubric**:
- Required: `September 30`, `3 days`
- Forbidden: `before you arrive` (vague deferral without the date)

**Edge**: If ≤3 days out, do not promise September 30 — send / promise shortly in this conversation instead.
