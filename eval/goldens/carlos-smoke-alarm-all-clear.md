# Golden: Smoke-alarm all-clear — Carlos (Apt 2)

**Scenario**: We auto-sent a Ring smoke notice to Carlos in Pine Apt #2. Four minutes later he replies that everything is good — something was boiling, and Richard came up to check.

## Rubric
- shouldReply: true
- expectedType: FYI_STATEMENT
- MUST contain "Thanks for letting us know", "everything is okay", "Glad you are all safe"
- MUST NOT repeat the alarm notice: no 911, no "Please check now", no "smoke detector just went off"

## Good response
"Thanks for letting us know everything is okay, Carlos! Glad you are all safe — and thanks to Richard for checking in."

"Thanks for letting us know everything is okay, Carlos! Glad you are all safe."

## Bad response (the production miss)
No reply. Recent-host suppression treated our smoke notice as "we already answered" and sent nothing.

## Notes
Carlos · Apt 2 · 2026-08-26. Reservation `660075cd-d520-4de9-bece-9860625728d5`. Policy layer `_applySmokeAlarmAllClearPolicy` is the hard backstop. Guest-initiated cooking FYIs (fried eggs / no prior host notice) still use the existing FYI_STATEMENT path.
