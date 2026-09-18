# sarah-checkout-thanks

## Rubric
- shouldReply: true
- expectedType: THANK_YOU_MESSAGE
- MUST contain "You're welcome" using guest name "Sarah"
- MUST contain warm thanks-for-staying / glad you enjoyed language
- MUST contain "Safe travels" OR "hope to see you again" (end-of-stay farewell)
- MUST be more than a bare one-liner "You're welcome, Sarah!"
- Tone: warm, multi-sentence, natural farewell after checkout

## Good response examples
"You're welcome, Sarah! Thanks for staying with us — glad you had a great stay. Safe travels!"

"You're welcome, Sarah! Glad you enjoyed your stay. Hope to see you again — Safe travels!"

## Bad response (production bug)
"You're welcome, Sarah!"

## Notes
Sarah · Booker checkout incident. Distinct from `amie-temporary-departure-thanks` (in-stay step-out must NOT get safe travels). Policy `_hasWarmPostCheckoutThanks` + `_checkoutThanksReplySnippet` enrich thin LLM drafts.
