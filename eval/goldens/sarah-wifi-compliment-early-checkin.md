# sarah-wifi-compliment-early-checkin

## Rubric
- shouldReply: **true**
- expectedType: **EARLY_CHECKIN** (primary actionable; thanks/FYI ok)
- MUST mention **4pm** check-in
- MUST promise to message when **cleaning finishes** / **getting the unit ready**
- MUST include **message you** (or equivalent promise to notify)
- MUST NOT say **check with the cleaning team**
- MUST NOT say **if we can accommodate**
- MUST NOT contain **Ansia_2.4** or **10286500**
- MUST NOT dump WiFi credentials ("The WiFi network is…") — compliment is not a password ask

## Good response
"Good afternoon, Sara. Check-in is at 4pm and we can't guarantee early check-in, but as soon as cleaning finishes getting the unit ready for you we'll message you right away."

## Bad (production miss ~2026-09-17 15:32 PT)
"You're welcome, Sara! The WiFi network is Ansia_2.4 and the password is 10286500 (all lowercase). Let me know if it works."
(Wrong global SSM WiFi + early check-in dropped.)

## Notes
Sara · Cozy West End Victorian · Sep 20–22 2026. Credential source of bug: SSM `/host/contacts-json` wifiSsid/wifiPassword (Ansia_2.4 / 10286500) via `_wifiCredentials` / `_applyWifiPolicy`. Correct per-unit WiFi is Pineland / lobsterbake from check-in templates apt-1b/2/3. Compliment + early → EARLY_CHECKIN classic only.
