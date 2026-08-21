# Golden: Crib / Pack and Play Request — First Host Message (Greeting + Pre-placed Fact)

**Scenario**: Guest (Kyrie · Booker) asks about crib availability for new baby while celebrating mom's birthday. This is the very first message from the host/auto-reply in the thread (empty conversationHistory). Real production case that exposed two bugs.

**Approved ideal behavior**:
- Recognize as PACK_AND_PLAY_BRAND (or equivalent misc amenity).
- Because it is the first host message in the conversation, start with time-based Eastern greeting + guest's natural name (e.g. "Good afternoon Kyrie,"). Time in scenario is ~2pm ET → Good afternoon.
- Clearly state that we use the Graco Pack and Play **and it is already set up / present / ready in the unit**. No language implying we will "get one ready", "prepare", or that guest must "let us know" to arrange.
- Keep warm, concise, practical. Address the request directly. Can acknowledge the trip briefly if natural but not required.
- shouldReply: true

**Rubric requirements**:
- Category: PACK_AND_PLAY_BRAND (preferred) or acceptable misc category that still gives the fact.
- Must reply.
- Must contain "Graco Pack and Play".
- Must contain language indicating it is "already" set up / present / ready (no prep step).
- Forbidden: any phrase suggesting "happy to have one ready", "get it ready for you", "just let us know", "upon request" in the response.
- Must start with a greeting using "Good afternoon" (or correct time-based) + "Kyrie" (natural name after normalization of "Kyrie · Booker").
- No robotic full name repetition.

**Example of good output** (tone and facts matter more than exact words):
"Good afternoon Kyrie, yes we use the Graco Pack and Play and it's already set up and ready in the unit for you."

**Why this golden exists**:
- Locks the "all units have one pre-placed" fact (no misleading "upon request / prepare" language).
- Locks the smart first-host-message greeting behavior for non-welcome categories (the old system did this well via checkRecentGreetings + dynamic instructions; harness now re-uses the pattern via ConversationContextTool + traces + injected instructions).
- This is the **future-guest availability** case. If the guest is already in the unit asking *where* the crib is, see `michael-in-stay-crib-location` instead (Apt 2: closet of the smaller bedroom).
