# Reviews

**Categories covered**:
- REVIEW_LINK_REQUEST
- REVIEW_SUBMITTED
- REVIEW_PROMISE

**REVIEW_LINK_REQUEST**:
- Guest can't find the review link or asks for it.
- Tell them they should receive an email from Airbnb.
- Ask them to check spam.
- Thank them and say you'll leave a 5-star review for them as excellent guests.

**REVIEW_SUBMITTED**:
- Guest says they left a review (especially if they mention 5 stars).
- Thank them.
- Say you'll leave a 5-star review for them too.
- "We hope to welcome you back again soon!"

**REVIEW_PROMISE**:
- Guest says they *will* leave a review, **or** confirms 5 stars after the host asked for a review (e.g. "You got 5!", "you got five", "5 stars") — even without the word "review". Use full conversation history: a prior host 5-star ask is context for interpreting bare "You got 5!".
- **Multi-intent with thanks**: emit `["THANK_YOU_MESSAGE", "REVIEW_PROMISE"]` (or equivalent) and combine in one reply — never a bare You're welcome only.
- Thank them for the (promised / confirmed) review / 5 stars.
- Say you'll leave a 5-star review for them because they were great guests.
- Never ship thin "You're welcome, [Name]!" alone when stars/review were promised (Alexandra 2026-09-19 production miss).
