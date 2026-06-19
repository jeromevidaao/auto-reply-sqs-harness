# rene-welcome-thanks

## Rubric
- shouldReply: true
- expectedType: THANK_YOU_MESSAGE
- MUST contain warm short "You're welcome" using guest name "Rene" naturally
- **MUST NOT** repeat any welcome logistics already sent in the prior host message: no 4pm, self-check-in, parking, pet fee, 3 days before, pets on bed/sofa, or second "Good afternoon, Rene" opener
- Tone: brief, warm, natural — this is a pure thanks after a full welcome was already delivered 1 minute earlier

## Good response examples
"You're welcome, Rene!"

"You're welcome, Rene! So glad you're excited — looking forward to hosting you and Rosie."

## Bad response (the production bug)
"Good afternoon, Rene, Thanks for the note — sounds like a wonderful trip ahead! Since you have a pet, the $30 pet fee is already included... Check-in is at 4pm with self-check-in..."

## Notes
Rene · Booker incident. Regression pairs with Olivia (greeting repetition) and Taylor (policy contradiction) guards. Policy layer `_applyPostWelcomeThankYouPolicy` is the hard backstop when the LLM misclassifies as NEW_RESERVATION_WELCOME.