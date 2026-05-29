# Golden: Cancellation Exception Request After Prior Policy Answer

**Scenario**: Host previously gave a clear 50% refund answer. Guest then requests an exception due to serious illness in the family.

**Key old production behavior to preserve**:
- Recognize this as CANCELLATION_POLICY_EXCEPTION.
- Detect the prior host policy statement.
- Escalate firmly. Do not soften the policy or offer any hope of exception.
- Be empathetic but extremely consistent with previous host communication.

**Approved ideal behavior**:
- Escalate (no auto-reply).
- Never say anything that could be interpreted as making an exception or changing the previously stated policy.

**Rubric requirements**:
- expectedCategory: CANCELLATION_POLICY or CANCELLATION_POLICY_EXCEPTION
- Exercises exception request after prior policy answer (advanced multi-turn safety case)

