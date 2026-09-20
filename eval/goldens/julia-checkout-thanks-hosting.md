# julia-checkout-thanks-hosting

## Rubric
- shouldReply: true
- expectedType: THANK_YOU_MESSAGE
- MUST contain "You're welcome" using guest name "Julia"
- MUST contain warm thanks-for-staying / glad you enjoyed language
- MUST contain "Safe travels" OR "hope to see you again" (end-of-stay farewell)
- MUST be more than a bare one-liner "You're welcome, Julia!"
- Tone: warm, multi-sentence, natural farewell after checkout + thanks for hosting

## Good response examples
"You're welcome, Julia! Thanks for staying with us — glad you had a great stay. Safe travels!"

"You're welcome, Julia! Glad you enjoyed your stay. Hope to see you again — Safe travels!"

## Bad response (production bug)
"You're welcome, Julia!"

## Notes
Julia · Downtown Studio checkout ~2026-09-20. Guest: "Jerome. We are all checked out. Thanks for hosting!!"
Root cause: `guestArrived` (Schlage PIN from check-in) made `_applyInStaySeeYouSoonPolicy` treat the short thanks as an in-stay pure ack and overwrite the warm post-checkout farewell with bare You're welcome.
Fix: skip in-stay see-you-soon / pure-ack on post-checkout; detect "thanks for hosting"; judge REVISE bare You're welcome; re-apply post-checkout policy after in-stay policies.
Distinct from `julia-morning-checkin-thanks` (in-stay enjoying) and `amie-temporary-departure-thanks` (no safe travels mid-stay).
