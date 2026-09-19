# alexandra-review-promise-you-got-5

Guest (exact): "Thanks again, Jerome! You got 5!" after host asked for a 5-star review.

**Must reply** as REVIEW_PROMISE (+ THANK_YOU) — not bare You're welcome.

Required:
- You're welcome
- 5-star (thank for stars + reciprocal)

Must not:
- lockout / lockbox recovery
- see you soon

Example good:
"You're welcome, Alexandra! So glad you had a terrific trip — thank you for the kind words and the 5-star review. We'll leave you a 5-star review as well. Hope to host you again in Portland soon!"

Bad (production miss):
"You're welcome, Alexandra!"

Alexandra · Cozy West End Victorian · Sep 17–19 2026. Root: "You got 5!" had no word "review"; thin You're welcome passed as isGood. Fix: `_guestPromisedOrGaveStars` + `_hasGoodReviewPromiseAck` + judge REVISE + thank-you/review prompts. Full history (prior host 5-star ask) is required context.
