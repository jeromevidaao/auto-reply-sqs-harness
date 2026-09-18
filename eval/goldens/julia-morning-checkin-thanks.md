# julia-morning-checkin-thanks

## Rubric
- shouldReply: true
- expectedType: THANK_YOU_MESSAGE
- MUST contain "You're welcome" using guest name "Julia"
- MUST contain enjoying-stay / glad-you context (e.g. "Glad you're enjoying your stay") — bare "You're welcome, Julia!" alone is a FAIL
- MUST NOT repeat formal "Good morning, Julia" from the prior host check-in
- MUST NOT add safe travels (guest is mid-stay) or re-send logistics
- Tone: warm, short, references the settled-in / enjoying context from host check-in + guest "so far so good"

## Good response examples
"You're welcome, Julia! Glad you're enjoying your stay."

"You're welcome, Julia! Glad to hear you're enjoying the stay."

## Bad response (production bug)
"You're welcome, Julia!"

## Notes
Julia · Booker Downtown Studio Parking with EV, Sep 17–20. Host 07:00 morning check-in → guest 07:08 TYSM. Root: thank-you path stayed at bare ack without reading prior host message. Fix: `_inferThankYouContext` + `_applyContextualThankYouPolicy` + CRITICAL prompt rule. Distinct from Amie (bare mid-stay step-out), Rene (bare post-welcome), Sarah (warm checkout farewell).
