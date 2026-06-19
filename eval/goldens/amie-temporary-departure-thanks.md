# amie-temporary-departure-thanks

## Rubric
- shouldReply: true
- expectedType: THANK_YOU_MESSAGE
- MUST contain a warm short acknowledgment using "You're welcome" (requiredPhrases)
- MUST use the guest's natural name "Amie" naturally (e.g. "You're welcome, Amie!")
- **MUST NOT** contain "safe travels", "hope you enjoyed", "have a great trip", or any end-of-stay farewell — guest is still staying tonight (check-in day Jun 19, checkout Jun 21)
- Tone: brief, warm, natural. Guest stepped out temporarily so Richard could leave a blanket by the door; this is NOT checkout.

## Good response examples
"You're welcome, Amie!"

"You're welcome, Amie."

## Bad response (production bug)
"You're welcome, Amie! Safe travels."

"You're welcome, Amie! Hope you enjoyed your stay."

## Notes
Exact user-provided incident (Jun 19 check-in day, 53 Pine #1B). Richard found a blanket and knocked; guest said "Thank you we just left the apartment!" so he could leave the black bag by the door. Auto incorrectly treated this as end-of-stay departure. Stay timing is current; checkout is still Jun 21. Pairs with pre-check-in parking Amie guard and in-stay departure deterministic policy in agent.js.