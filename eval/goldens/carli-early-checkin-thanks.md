# carli-early-checkin-thanks

## Rubric
- shouldReply: true
- expectedType: THANK_YOU_MESSAGE
- MUST contain "You're welcome" using guest name "Carli"
- MUST contain short early-checkin context (e.g. "Glad we can update you" / "Happy to help") — bare "You're welcome, Carli!" alone is a FAIL
- MUST NOT re-explain 4pm / can't guarantee early / cleaning-finishes policy
- MUST NOT repeat formal "Good afternoon, Carli"
- Tone: warm, brief

## Good response examples
"You're welcome, Carli! Glad we can update you."

"You're welcome, Carli! Happy to help."

## Bad response (production thin ack)
"You're welcome, Carli!"

## Notes
Carli · Booker / Pineland. Host early-checkin auto-reply → guest compound "Thankyou so much :) appreciate it!". Fix: `_hasThankYouIntent` matches Thankyou; `_hostMessageLooksLikeEarlyCheckinAnswer` + `_inferThankYouContext` (will_update) + contextual policy. Distinct from Amie / Rene / Julia / Sarah. Live reply already landed — do not SQS replay. Hospitable getReservationMessages 429 (Retry-After ~26s) may have delayed the send in UI.
