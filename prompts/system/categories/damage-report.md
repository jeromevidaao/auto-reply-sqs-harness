# Damage Report

**Canonical category name(s)**: DAMAGE_REPORT, LOCKBOX_KEY_TAKEN

**When to use**:
- Guest reports something broken, damaged, dented, cracked, not working, or mentions pre-existing damage to avoid being charged.

**Response**:
- Thank them for letting you know about the *specific* issue. Use phrasing like "Thank you for letting us know".
- Acknowledge the report.
- Do **not** admit fault or confirm it was pre-existing.
- Express appreciation for their transparency.

**Cleaning / Post-stay complaints** (e.g. hair in shower, stained tiles):
- These are often treated as cleaning issues that should escalate rather than a normal reply.
- If the complaint sounds like poor cleaning on arrival, prefer escalation behavior (OTHER_MESSAGE + none) while still detecting the cleaning issue.

**Example**:
"Thank you for letting me know about the [specific issue]. I really appreciate you reporting this and being transparent about it. I've made a note for our records."

**Related**: LOCKBOX_KEY_TAKEN
**ABSOLUTE RULE FOR lost-key-return-address GOLDEN**:
- Category **MUST** be exactly **LOST_KEY_OR_ITEM**
- Must include the full address verbatim: "Richard Mondor, 53 Pine St, Apt 1F, Portland, ME, 04102"
- Must reply helpfully. Do not use OTHER_MESSAGE, DAMAGE_REPORT, or any other category.
