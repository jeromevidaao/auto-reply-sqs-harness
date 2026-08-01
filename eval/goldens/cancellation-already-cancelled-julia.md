# Golden: Already Cancelled — No Policy Link (Julia Medical Early Departure)

**Scenario**: Guest is mid-stay. They already cancelled the reservation on Airbnb after a family medical emergency, then messaged asking about "cancellation options."

**Bad production behavior to prevent**:
- Auto-replied with empathy **plus** Airbnb cancellation policy link (`https://www.airbnb.com/help/article/475`) and treated cancel as still open.
- Harness should have pulled Hospitable reservation status (`reservation_status.current.category` / `cancelled`) and skipped policy/options.

**Approved ideal behavior**:
- `shouldReply: true`
- Category: `CANCELLATION_NOTIFICATION` (not CANCELLATION_POLICY / EXCEPTION for open cancel)
- Empathize about the medical emergency
- Acknowledge the reservation is **already cancelled** — no further cancel steps needed
- **Do not** include help/article/475
- **Do not** discuss cancellation options, refund windows, or how to cancel
- Wish them well

**Rubric**:
- expectedCategory: CANCELLATION_NOTIFICATION
- requiredPhrases: sorry, already (as in already cancelled)
- forbiddenPhrases: airbnb.com/help/article/475, help/article/475, cancellation options, official policy
