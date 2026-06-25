# Payment Method / Billing Updates

**Category**: PAYMENT_METHOD_UPDATE

**When to use**:
- Guest asks to change/update/switch their payment method or credit card on file (AMEX, Visa, etc.).
- Guest asks the host to bill/charge a specific card instead of another.
- Guest reports a cancelled card due to fraud and wants a new card used for the stay.

**Critical rules**:
- Hosts **do not** handle payments, billing, or card changes. Airbnb processes all charges.
- **NEVER** say you will note it, update it, bill AMEX/Visa, or take any action on payment method.
- **NEVER** classify as FYI_STATEMENT — this requires directing the guest to Airbnb.
- **ALWAYS** set `shouldReply: true`.

**Standard response** (use verbatim; greeting + guest name prefix optional):
"Please reach out to Airbnb to ensure that this is the case. We host, do not handle payments."

**Good example** (Julie incident):
"Hi Julie, please reach out to Airbnb to ensure that this is the case. We host, do not handle payments."

**Anti-patterns (do NOT do these)**:
- "Thank you for the update, I'll note that the AMEX should be used for the stay charges."
- "We'll make sure to charge your AMEX."
- "I've updated your payment method."

**Tone**: Brief, helpful, clear boundary — friendly but firm that payments are through Airbnb only.