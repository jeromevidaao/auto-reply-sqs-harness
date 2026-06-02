# Golden: First post-booking birthday welcome (Abby)

**Scenario**: Guest's first message after booking, casual intro about celebrating boyfriend + twin's 30th birthday in Portland. Empty conversationHistory (first host/auto-reply message in thread). Must classify as NEW_RESERVATION_WELCOME and deliver a rich informative reply with the key facts the old system provided (not a minimal acknowledgment + "let me know questions").

**Context highlights**:
- Future stay (check-in in ~8 days >3d)
- No pets (petCount=0, no mention in msg)
- Guest name: Abby (simple)
- First host message → must use greeting + natural name

**Requirements**:
- expectedCategory includes NEW_RESERVATION_WELCOME
- shouldReply: true
- Must start with time-appropriate Eastern greeting + "Abby," (e.g. "Good afternoon, Abby,"). Time in scenario context implies afternoon.
- Warmly acknowledge the birthday plans/trip without robotic repetition.
- Must include core welcome info:
  - self-check-in
  - Check-in at 4pm (or "starts at 4PM")
  - Dedicated off-street parking (or "one off-street parking spot")
  - "I will send the detailed check-in instructions 3 days before your arrival." (exact or very close, since future >=3d)
- Must NOT be curt/minimal like "happy to hear... let me know if you have any questions about the apartment or Portland."
- No pet policy mention (correct, since no pets in res or msg)
- No "feel free to book"
- Sign naturally (Jerome or Jerome & Ruby ok if fits)
- Concise, warm, practical tone.

**Example of good output** (tone/facts > exact wording; must hit the required elements):
"Good afternoon, Abby, thanks for booking with us — happy to hear about the 30th birthday celebration! We have one dedicated off-street parking spot. Check-in is at 4pm with self-check-in, so you can arrive when it works for you. I will send the detailed check-in instructions 3 days before your arrival.

Looking forward to hosting you in Portland.

Jerome & Ruby"

**Rubric notes**: The previous curt reply failed because it omitted the practical logistics that make the first post-booking message useful (matching old system's rich welcome). This golden + scenario locks the behavior.
