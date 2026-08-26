# trevor-checkin-day-not-ready

## Rubric
- shouldReply: **true** (production sent nothing)
- expectedType: EARLY_CHECKIN (or EARLY_CHECKIN_QUESTION / CHECK_IN_TIME_QUESTION)
- MUST apologize that it is **not ready yet**
- MUST mention **4pm**
- MUST say we will **message you** when it is ready
- MUST NOT mention the cleaning button
- MUST NOT reply with only "You're welcome"
- MUST NOT say the unit is ready / they can check in now

## Good response
"Sorry Trevor, it is not ready yet. Coming back closer to 4pm is perfect — we'll message you as soon as it is."

## Bad (production)
- No reply / FYI_STATEMENT because the line had no `?` and a host "You're welcome" 2.7 minutes earlier
- "You're welcome, Trevor!" to "should we kill an hour?"
- "I'll check on readiness" without ever checking DynamoDB `cleaning`

## Notes
Trevor Dickson · Apt 3 · 2026-08-26 check-in 4pm after Stephen Couitt checkout 10am. DynamoDB `cleaning` `24259977_2026-08-26` had no `pressedAt`. Guest: "Ok we'll come back closer to 4 if it's not ready, figured we'd ask ;-)". Ground truth is the cleaning table, not a guess. Deterministic `_applyCheckInDayNotReadyPolicy`. Never tell the guest about the physical button.
