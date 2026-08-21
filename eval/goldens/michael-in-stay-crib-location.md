# michael-in-stay-crib-location

## Rubric
- shouldReply: true
- expectedType: PACK_AND_PLAY_BRAND
- MUST say the crib is in the **closet of the smaller bedroom** (Apt 2)
- MUST say **let us know if you cannot find** it
- MUST NOT use the future-guest availability line ("already set up and ready in the unit")
- MUST NOT treat this as "do you have a crib?"

## Good response
"Michael, it should be in the closet of the smaller bedroom. Let us know if you cannot find it."

## Notes
Michael · Apt 2 · 2026-08-21 check-in day. Guest: "Just entered the unit. Can you please remind me where the crib is located?" Production auto replied "Michael, the Graco Pack and Play is already set up and ready in the unit for you." That is the Kyrie-style answer for a **future** guest asking if we have one. Michael is already in the unit and looking for it.

Same reservation as `michael-not-checkin-day-access` (conversation `ffe1c445-ae5c-4020-879e-1d2401b5d75d`). Deterministic `_applyInStayCribLocationPolicy`. Physical arrival is confirmed via DynamoDB `guestCheckIns` (first Schlage PIN unlock — same signal as the dashboard / HeatPump).
