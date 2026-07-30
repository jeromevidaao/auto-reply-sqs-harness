# olivia-early-checkin-cleaning-process

## Rubric
- shouldReply: **true** (must auto-reply — this was the production miss)
- expectedType: EARLY_CHECKIN (or EARLY_CHECKIN_QUESTION / CHECK_IN_TIME_QUESTION)
- MUST NOT classify or escalate as a cleaning complaint
- MUST include standard early check-in policy: cannot guarantee early / check-in 4pm / message if ready earlier
- MUST acknowledge early Sunday departure / cleaning process courtesy warmly
- MUST use guest name Olivia
- MUST NOT claim unit is ready early (no prior host readiness in history)
- HeatPump / thermostat tools must NOT treat this as HVAC relevant ("opportunity" ≠ "unit")

## Good response examples
"Good evening, Olivia, we can't guarantee early check-in since the unit needs preparation time, but if cleaning finishes before 4pm we'll message you right away. Thanks for the heads-up on your early Sunday departure—we'll note that."

"Hi Olivia — check-in is at 4pm and we can't guarantee earlier, but if the unit is ready before then we'll message you. Appreciate the note that you'll head out early Sunday so cleaning can start sooner!"

## Bad (production bug)
- No reply / escalation only because message contained "cleaning process"
- Auto-setting heat pumps because "opportunity" contains "unit"
- Treating as CLEANING_ISSUE / forcing proposedResponse none

## Notes
Exact Olivia message 2026-07-30T23:12Z, reservation 22471edf-6221-4900-9609-88a925499e9a, Apt 3. Root cause pair: CleaningIssueTool bare "cleaning" + HeatPumpTool substring "unit".
