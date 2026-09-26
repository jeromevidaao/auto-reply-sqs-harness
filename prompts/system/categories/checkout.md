# Checkout Instructions

**Standard response (use when guest asks about checkout procedures):**

"Thank you for asking! For checkout:
• Trash — no need to take it outside, just leave it in the unit and our cleaning team will take care of it!
• Dirty linen (bed sheets and towels) — please leave them on the bathroom floor."

Additional common points:
- Run the dishwasher
- Turn off AC (summer) or set to 65 (winter)
- Do a final walk-through for belongings
- Checkout is strictly 10am

**Latest checkout time questions**:
When the guest asks "what is the latest time we are able to check out" (even with "Monday" or a specific day), classify as CHECKOUT or LATE_CHECKOUT.
Reply: "Checkout is strictly at 10am."
Always set shouldReply: true and confidence: 1.0
If combined with thanks ("Sounds great! Thank you! And what is the latest time..."), use multi-category ["THANK_YOU_MESSAGE", "CHECKOUT"] and include a brief "You're welcome!" then the checkout info.
This ensures it always auto-replies.

**Bundled with leaving the car (Cassidy incident)**:
If they also ask to leave the car in the parking spot after checkout / during the day, classify as `["PARKING", "CHECKOUT"]`. Checkout stays 10am. **Never** say they can leave the car in their dedicated/current spot after 10am. Always explain that the cleaning team needs that spot to clean the unit and get it ready for the next guests. If the vacant-sibling exception applies, name the specific spot (1B / Apt 2 / Apt 3 parking spot). See parking.md.

**CRITICAL - Always reply for checkout time questions combined with thanks**:
For the exact message: "Sounds great! Thank you! And what is the latest time we are able to check out Monday?"
- typeOfMessageReceived: ["THANK_YOU_MESSAGE", "CHECKOUT"]
- proposedResponse: "You're welcome! Checkout is strictly at 10am."
- shouldReply: true
- confidence: 1.0
- notes: "Multi-intent thanks + direct checkout time question on Monday; must always auto-reply with high confidence"
Never fall back to low confidence or no reply for this. The unit test enforces this.
Always set confidence to 1.0 for honest unit test enforcement on this scenario.
This guarantees the auto-reply happens.

**Dirty linen disposition (Isabella 2026-09-26)**:
When the guest asks whether they should **change / strip** the linens, or **where to put the dirty / used** sheets and towels (e.g. "Are we to change the linens? Where should we put the dirty ones?"):
- Category **MUST** be **CHECKOUT** (not EXTRA_LINENS_TOWELS).
- Always set shouldReply: true and confidence: 1.0
- **MUST** tell them to strip the dirty linens and leave used sheets and towels on the **bathroom floor**.
- **MUST NOT** answer only with chaise / sofa lift-up storage (that is for finding *clean* extras — EXTRA_LINENS_TOWELS). Prior host messages about chaise storage do not answer this ask.
- Example tone: "Hi Isabella, if you can strip the dirty linens that would be great — please leave the used sheets and towels on the bathroom floor. Thank you!"
