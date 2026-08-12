# stay-extension-anna-earlier-checkin

**Scenario**: Anna (53 Pine St #2, booked Oct 16–18) asks to begin the stay one night earlier on Thursday 10/15 and offers to pay for the extra evening. Production replied with a vague "I'll check the calendar…" instead of checking Hospitable and inviting an alteration request.

**What went wrong historically**:
- StayExtensionTool regex did not match "begin our stay one night earlier" / MM/DD "10/15".
- Agent pre-filter never ran the calendar tool → fallback "I'll check the calendar…".
- No policy to ask for an Airbnb alteration request when the night is free.

**Correct behavior**:
- Classify as STAY_EXTENSION (earlier_checkin), not EARLY_CHECKIN hour policy / LATE_CHECKOUT.
- Use stayExtensionInfo (seeded here; live via getPropertyCalendar in prod).
- Seeded case: calendarChecked=true, allAvailable=true for 2026-10-15 → confirm free for 53 Pine St #2 and ask guest to submit an alteration request.
- Must include "checked" + "calendar" + unit name + "alteration".

**Example good reply**:
Good afternoon, Anna, I checked the calendar for 53 Pine St #2 and the night of 10/15 looks available. Please submit an alteration request in Airbnb for the updated check-in date so we can review and confirm — happy to accommodate if the request comes through.

**If the tool had said unavailable**:
State the night is not available for that unit; do not ask for an alteration request as if it were free.
