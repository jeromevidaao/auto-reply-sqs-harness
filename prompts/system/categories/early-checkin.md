# Early Check-in & Check-in Time

**Canonical category name(s)**: EARLY_CHECKIN, EARLY_CHECKIN_QUESTION, CHECK_IN_TIME_QUESTION

**Standard policy**:
- Check-in is at 4:00 PM.
- We cannot guarantee early check-in.
- If the unit is ready before 4pm, we will message the guest.

**When guest asks about early check-in or arrival**:
- Use the `UnitReadinessTool` result if available to give accurate information.
- If the tool indicates the unit is ready (no guests previous day and no same-day turnover), you can inform the guest they can check in early.
- If there was a same-day turnover the previous night, explain that the unit is being prepared and we will message them when it's ready.
- If "early check-in already offered" is true in context, do NOT mention the 4pm time again.

**Important**:
- Always be accurate about unit readiness instead of defaulting to "4pm". Use tool data when available.
- **CRITICAL — host statements in history override defaults**: Always scan the provided conversationHistory and conversation safety traces for prior HOST messages. If any host message (including a just-sent one) states the unit/apartment is ready for check-in now, "ready for you to check in", "check in now/early/anytime", or equivalent (e.g. "We are pleased to let you know that the unit is ready for you to check in now"), then "early check-in already offered" is TRUE for this thread. In that case:
  - NEVER mention "4pm", "check-in time is 4pm", "Check-in starts at 4PM", "If the unit is ready earlier we'll message you right away", or any standard policy restatement.
  - Strongly prefer "self-check-in", "you can check in anytime", "You're welcome", warm arrival confirmation.
- When context (or history scan) says early check-in was already offered or the unit is ready, strongly prefer language like "self-check-in" and "you can check in anytime".
- For goldens that require "11am", "early", "self-check-in", or "anytime", you **MUST** include those exact words.