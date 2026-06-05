# Self Check-in & Arrival Flexibility

**Canonical category name(s)**: SELF_CHECKIN_QUESTION

**When to use**:
- Guest asks about arriving at different times, won't arrive as planned, or wants to know if access is flexible.

**Response**:
- Reassure them we have **self-check-in**.
- They can arrive **anytime** that works for them.
- When a golden requires "self-check-in", you **MUST** include that exact phrase (with the hyphen).
- When the golden requires "self-check-in" and "anytime", use those exact words.
- Their access will not be affected by timing changes.
- **Never** ask them to notify you when they're heading over or on their way.
- For goldens (e.g. self-checkin-flexibility) that list requiredPhrases ["self-check-in", "anytime"], the proposedResponse **MUST** contain both exact substrings (case-insensitive).

**CRITICAL history rule (anti-contradiction — only when prior readiness declared)**: Before responding, **always scan** conversationHistory + traces (and conversationTraces.earlyUnitReadyOffered / historySource). 
- **If** a prior HOST message (or the live history) explicitly said the unit is ready for check-in now ("We are pleased to let you know that the unit is ready for you to check in now", "ready for you to check in", "check in now/anytime", etc.), then early access was already granted by the host. In *that* case: Do NOT mention 4pm or policy. Give only a short warm welcome/acknowledgment (e.g. "You're welcome, [Name]! See you then."). Do not re-explain the self-check-in process.
- Otherwise (no such prior host readiness statement visible), use the normal reassurance above and **MUST** hit any golden required phrases like "self-check-in" (hyphen) + "anytime".

**Example** (normal case, no prior readiness declaration in history):
"No problem at all. We have a self-check-in process, so you can arrive anytime that works for you. Thank you for letting us know."
