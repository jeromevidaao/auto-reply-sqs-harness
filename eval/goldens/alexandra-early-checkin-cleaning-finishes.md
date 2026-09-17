# alexandra-early-checkin-cleaning-finishes

## Rubric
- shouldReply: **true**
- expectedType: EARLY_CHECKIN (or EARLY_CHECKIN_QUESTION / CHECK_IN_TIME_QUESTION)
- MUST mention **4pm** check-in
- MUST promise to message when **cleaning finishes** / **getting the unit ready**
- MUST include **message you** (or equivalent promise to notify)
- MUST NOT say **check with the cleaning team**
- MUST NOT say **if we can accommodate**
- MAY acknowledge around 3 without guaranteeing it

## Good response
"Good afternoon, Alexandra. Check-in is at 4pm so we can't guarantee an arrival around 3pm, but as soon as cleaning finishes getting the unit ready for you we'll message you right away."

"Hi Alexandra — check-in is at 4pm and we can't guarantee earlier, but if cleaning finishes getting the unit ready before then we'll message you right away."

## Bad (production miss ~2026-09-17 09:36 PT)
"Good afternoon, Alexandra. I'll check with the cleaning team and let you know if we can accommodate an earlier arrival around 3pm."

## Notes
Alexandra · Apt Cozy West End Victorian · Sep 17–19 2026. Root cause: LLM early-check-in draft used vague "check with cleaning / if we can accommodate" instead of the standard "message when cleaning finishes / unit ready" promise. Fix: `early-checkin.md` copy rules + deterministic `_applyEarlyCheckinReplyPolicy`. Do not send a live follow-up to Alexandra unless Jerome asks — harness fix only.
