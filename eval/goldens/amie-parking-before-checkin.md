# amie-parking-before-checkin

## Rubric
- shouldReply: true
- expectedType: PARKING (or early check-in related category)
- MUST explain check-in is at 4pm and we cannot guarantee the designated spot before then
- MUST mention cleaning team may still be using the spot
- MUST say we will message when the spot is ready
- **MUST NOT** say "yes", "the designated spot is available", or confirm they can park before check-in without a prior host readiness message

## Good response examples
"Hi Amie, check-in is at 4pm, so we can't guarantee the designated parking spot before then. The cleaning team may still be using it while the unit is being prepared. We'll message you as soon as the spot is ready for you."

## Bad response (production bug)
"Good morning, Amie, yes the designated spot is available for you. If the cleaning team is still there when you arrive we'll message you as soon as it's free."

## Notes
Only confirm early designated-spot parking when a prior host message explicitly offered unit readiness (earlyUnitReadyOffered).