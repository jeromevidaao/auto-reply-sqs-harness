# michael-in-stay-thanks-see-you-soon

## Rubric
- shouldReply: true
- expectedType: THANK_YOU_MESSAGE
- MUST say You're welcome
- MUST NOT say see you soon / see you then / looking forward to hosting you
- Guest is already in Apt 2 (Schlage PIN / guestArrived)

## Good response
"You're welcome, Michael!"

## Notes
Michael · Apt 2 · 2026-08-21 after sofa-bed help. Guest: "All set" then "Richard popped in and helped" then "Thanks". Production auto: "You're welcome, Michael! See you soon." then a second "You're welcome!" (processing lag). He had already entered the unit. "See you soon" is for guests who have not arrived yet (Taylor). Deterministic `_applyInStaySeeYouSoonPolicy`. Pre-send thread refresh (`runPreSendThreadRefresh`) reprocesses if newer guest messages arrived and skips a duplicate you're-welcome already on the thread.
