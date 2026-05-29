# Golden: Multi-turn Cancellation Question (Anti-Repetition)

**Scenario**: Guest asks about cancellation policy twice. The second answer must not repeat the exact same phrasing and structure as the first host reply.

**Key old production behavior to preserve**:
- Stay accurate on policy.
- Always include the official link.
- Vary language to avoid robotic repetition (a known production problem).
- The Conversation Judge is supposed to catch this.

**Approved ideal behavior**:
- Accurate 50% (or whatever the math is) information on the second ask.
- Still links to the official policy page.
- Uses different sentence structure and flow from the previous host message in history.
- Does not sound like a template repeat.

**Rubric requirements**:
- expectedCategory: CANCELLATION_POLICY
- shouldReply: true
- Must include the official policy link
- Must NOT repeat the exact phrasing "50% refund including taxes" + "You can cancel directly on Airbnb" from the prior turn
