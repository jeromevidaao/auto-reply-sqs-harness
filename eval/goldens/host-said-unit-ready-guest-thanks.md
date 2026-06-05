# Golden: Host Said Unit Ready — Guest Thanks + Arriving Soon

**Scenario (exact production bug)**: At ~9AM host (or prior auto) sent: "Hi Taylor, We are pleased to let you know that the unit is ready for you to check in now." Guest immediately replied: "Ahh that’s perfect!! We will be arriving in about an hour! Thank you". The bad auto-reply said: "Good afternoon, Taylor, thanks for letting us know! Check-in time is 4pm. If the unit is ready earlier we'll message you right away." — direct contradiction of the just-made readiness statement.

**Root cause fixed**: No explicit "earlyUnitReadyOffered" trace from host history scan; weak "never contradict prior host" enforcement; greeting not suppressed; classification fell to generic check-in time response.

**Approved ideal behavior**:
- Detect via conversationHistory + ConversationContextTool that host already declared unit ready.
- Classify toward THANK_YOU_MESSAGE or SELF_CHECKIN_QUESTION / EARLY_CHECKIN follow-up.
- Reply warm, brief, name-based (no "Good afternoon" because recent host message in history).
- "You're welcome, Taylor!" + acknowledge the arrival update ("Perfect — see you in about an hour!") or similar.
- **Zero** mention of 4pm, check-in policy, "if the unit is ready earlier", cleaning, etc.
- Consistent with "if we (host) told them the unit is ready, the unit is ready — do not contradict".

**Rubric requirements (enforced by eval/runner.js)**:
- shouldReply: true
- Must NOT contain any of the forbidden 4pm/policy phrases (case-insensitive substring).
- May return array of categories including THANK_YOU_MESSAGE etc.
- In full pipeline (handleMessage + reflection/judge) the Conversation Judge must flag any 4pm contradiction as REVISE/REJECT (per augmented conversation-judge.md rule 3 + note).
- Traces must include earlyUnitReadyOffered (visible in logs / judge input).

**Good example responses** (natural variations OK):
"You're welcome, Taylor! Perfect — we'll see you in about an hour."
"You're welcome! Safe travels, see you soon."
"Taylor, you're welcome — great, looking forward to hosting you in about an hour."

Any response that re-introduces default 4pm language after an explicit host readiness statement in history is a failure (even if category is correct).

This scenario + the new earlyUnitReadyOffered signal + strengthened prompts + judge rules close the regression permanently.
