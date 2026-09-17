# sarah-wifi-compliment-early-checkin

## Rubric
- shouldReply: **true**
- expectedType: multi-intent including **EARLY_CHECKIN** (plus thanks / WiFi ack)
- MUST acknowledge **WiFi** (compliment ack or credentials)
- MUST mention **4pm** check-in
- MUST promise to message when **cleaning finishes** / **getting the unit ready**
- MUST include **message you** (or equivalent promise to notify)
- MUST NOT say **check with the cleaning team**
- MUST NOT say **if we can accommodate**
- MUST answer BOTH the WiFi compliment and the early check-in ask in one reply

## Good response
"You're welcome, Sara! Glad you like the WiFi. Check-in is at 4pm and we can't guarantee early check-in, but as soon as cleaning finishes getting the unit ready for you we'll message you right away."

## Bad (production miss ~2026-09-17 15:32 PT)
"You're welcome, Sara! The WiFi network is Ansia_2.4 and the password is 10286500 (all lowercase). Let me know if it works."
(WiFi only — early check-in dropped entirely.)

## Notes
Sara / Sarah · Cozy West End Victorian · Sep 20–22 2026. Root: `_isWifiPasswordAsk` matched "I love your WiFi password!" and `_applyWifiPolicy` overwrote the early-check-in draft. Fix: `_isWifiCompliment` + `_applyWifiEarlyCheckinMultiIntentPolicy` (and wifi policy merges early when both present). Live follow-up should answer early check-in only (do not re-spam full WiFi).
