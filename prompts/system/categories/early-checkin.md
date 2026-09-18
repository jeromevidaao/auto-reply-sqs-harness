# Early Check-in & Check-in Time

**Canonical category name(s)**: EARLY_CHECKIN, EARLY_CHECKIN_QUESTION, CHECK_IN_TIME_QUESTION

**Standard policy**:
- Check-in is at 4:00 PM.
- We cannot guarantee early check-in.
- If the unit is ready before 4pm, we will message the guest.

**Reply copy (CRITICAL — Alexandra 2026-09-17 production miss)**:
- ALWAYS promise to message the guest **as soon as cleaning finishes getting the unit ready** (or equivalent: "if cleaning finishes … we'll message you right away").
- You MAY acknowledge a requested time (e.g. around 3) without guaranteeing it.
- NEVER use vague deferrals like "I'll check with the cleaning team", "let you know if we can accommodate", "I'll check on readiness", or "if we can accommodate an earlier arrival".
- Preferred pattern: warm greeting + cannot guarantee early check-in + "as soon as cleaning finishes getting the unit ready for you we'll message you right away".

**When guest asks about early check-in or arrival**:
- Use the `UnitReadinessTool` result if available to give accurate information.
- Ground truth is DynamoDB `cleaning` `{airbnbListingId}_{check-in date}` **`pressedAt`**: if a previous-night guest checked out and there is no `pressedAt`, the unit is **not ready**.
- If the tool indicates the unit is ready (no guests previous night, or cleaning is complete), you can inform the guest they can check in early.
- If there was a previous-night guest and cleaning is not complete, apologize that it is **not ready yet**, confirm check-in is 4pm, and say we will message them as soon as it is. Do **not** reply with only "You're welcome". Do **not** mention the cleaning button to the guest.
- Check-in-day "we'll come back closer to 4 if it's not ready" / "should we kill an hour" is an EARLY_CHECKIN ask even without a `?`. Always reply.
- If "early check-in already offered" is true in context, do NOT mention the 4pm time again.

**Handling flexibility questions (check-in and/or check-out times)**:
- Guests frequently ask simple direct questions like: "Is there any flexibility with check in or check out times? We were looking for earlier check in and later check out".
- For these straightforward cases (especially on inquiries or first messages with no complicating history):
  - Be honest and practical.
  - Typical good response style (use natural variations): "Hi Olivia, not for the checkout, but for the check-in we can message you as soon as the cleaning team finishes."
  - Checkout is usually not flexible (cleaning team needs to prepare the unit for the next guests).
  - Check-in: offer to message when ready after cleaning/turnover.
- **For simple, clear flexibility questions like the example above with no recent duplicate host reply on the exact topic and no safety/contradiction flags**: Always reply. Output high confidence (1.0) and shouldReply: true. Do not escalate these to manual.

**Important**:
- Always be accurate about unit readiness instead of defaulting to "4pm". Use tool data when available.
- **CRITICAL — host statements in history override defaults**: Always scan the provided conversationHistory and conversation safety traces for prior HOST messages. If any host message (including a just-sent one) states the unit/apartment is ready for check-in now, "ready for you to check in", "check in now/early/anytime", or equivalent (e.g. "We are pleased to let you know that the unit is ready for you to check in now"), then "early check-in already offered" is TRUE for this thread. In that case:
  - NEVER mention "4pm", "check-in time is 4pm", "Check-in starts at 4PM", "If the unit is ready earlier we'll message you right away", or any standard policy restatement.
  - Strongly prefer "self-check-in", "you can check in anytime", "You're welcome", warm arrival confirmation.
- When context (or history scan) says early check-in was already offered or the unit is ready, strongly prefer language like "self-check-in" and "you can check in anytime".
- For goldens that require "11am", "early", "self-check-in", or "anytime", you **MUST** include those exact words.

**Multi-intent (CRITICAL — Sarah 2026-09-17 WiFi + early check-in miss)**:
- If the guest **compliments** WiFi / the password and also asks for early check-in: primary category **EARLY_CHECKIN**; reply with the classic cleaning-finishes / message-you promise. Do **not** dump WiFi credentials for a compliment.
- If the guest **explicitly asks** for WiFi credentials and also early check-in: cover both (property-aware Pineland/lobsterbake for Pine St) in one reply.
- Never drop the early-check-in promise because you answered WiFi first. Never emit Ansia_2.4 / 10286500 for Pine St / West End Victorian.

