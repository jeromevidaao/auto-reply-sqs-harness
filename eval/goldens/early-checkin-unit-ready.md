# Golden: Early Check-in on Future Booking Where Unit Will Be Ready

**Scenario**: Guest asks about early check-in 5 days before arrival. No previous guests the day before → unit should be ready.

**Key old production behavior to preserve**:
- Use accurate readiness information instead of defaulting to "we cannot guarantee early check-in".
- When the unit is expected to be ready, give a helpful, positive answer while still protecting the 4pm standard time as the guaranteed time.
- Be specific when possible.

**Approved ideal behavior**:
- Acknowledge the request.
- Indicate that early check-in may be possible because the unit will be ready.
- Still note that 4pm is the standard guaranteed time.
- Offer to confirm closer to arrival.

**Rubric requirements**:
- expectedCategory: EARLY_CHECKIN_QUESTION
- shouldReply: true
- Must give positive/accurate information about potential early access
- Must NOT default to the negative "we cannot guarantee" stock phrase when conditions are favorable
