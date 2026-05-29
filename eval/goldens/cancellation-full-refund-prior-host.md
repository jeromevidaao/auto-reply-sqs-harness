# Golden: Cancellation Full Refund + Prior Host Commitment (Anti-Contradiction)

**Scenario**: Guest booked <24h ago and is 16+ days from check-in (qualifies for full refund). However, the host previously gave a vague answer about cancellation in the same thread.

**Key old production behavior to preserve**:
- Correctly identify that this qualifies for full refund mathematically.
- But detect the prior host statement and **escalate** instead of giving a new definitive refund answer.
- Never risk contradicting the host's earlier words.

**Approved ideal behavior**:
- Do **not** state "you would receive a full refund".
- Escalate to the host (shouldReply: false).
- Be conservative on high-risk policy topics when history exists.

**Rubric requirements** (enforced in eval):
- expectedCategory: CANCELLATION_POLICY
- Exercises prior host statement detection in cancellation context (advanced safety case)

