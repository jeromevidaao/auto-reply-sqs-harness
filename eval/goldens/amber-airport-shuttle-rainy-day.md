# amber-airport-shuttle-rainy-day

## Rubric
- shouldReply: true
- shouldAlwaysReply: true
- expectedType: THANKS / TRANSPORT_QUESTION / ACTIVITIES_QUESTION (any of these)
- MUST include "You're welcome"
- MUST answer the new questions (shuttle / taxi for 1am airport pickup, indoor rainy-day ideas)
- MUST NOT withhold the reply just because the host said good morning ~5 minutes earlier
- MUST NOT repeat "Good morning, Amber"

## Good response examples
"You're welcome, Amber! For the 1am airport run, the Portland Jetport shared-ride shuttle or a pre-booked taxi works well. For rainy days with the girls, the Children's Museum of Maine or the Portland Public Library are great indoor options."

## Production miss
2026-08-17 10:06 ET Apt 3. Draft existed (~314 chars) but `shouldReply` was forced false because `typeOfMessageReceived` was the array `['THANKS','TRANSPORT_QUESTION','ACTIVITIES_QUESTION']` and recent-host suppression compared it with `!== 'THANK_YOU_MESSAGE'` (always true for arrays). Reflection said the first draft incorrectly suppressed. Guest did not get the auto-reply.

At 14:15 UTC the follow-up "no Ubers" message hard-failed the Lambda: Hospitable 429 with Retry-After: 0 burned 4 GET attempts in 29s.

## Notes
Recent host activity must only suppress duplicate acks / greetings, never a new operational question.
Deterministic `_applyThanksPlusTransportActivitiesPolicy` forces a sendable draft if Grok returns OTHER_MESSAGE + none.
