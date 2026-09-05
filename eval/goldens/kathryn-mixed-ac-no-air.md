# Golden: Kathryn mixed-mode AC "no air" (live Kumo auto-fix)

**Scenario**: Follow-up message after initial AC complaint. Guest explicitly says the remotes are on with settings, still no air all night. (Apt 2 / Sunny — 3 heads.)

**Real incident context**:
- Guest was correctly using the wall remotes.
- One indoor head was set to "heat", the other two to "cool" (or auto?); the mismatched head was ~80F hot.
- Heat pumps cannot simultaneously heat and cool different zones — this is why "on but no air".
- Host manually diagnosed via Kumo app, set all three to auto at 65°F, and explained.

**Approved ideal behavior (post HeatPumpTool)**:
- Do **not** mention the Nest. Do **not** mention the apartment number.
- Name which rooms are on heat vs cool (odd-one-out first), then the same-mode rule.
- The live tool will have already fetched status and auto-set all heads.
- Reply must include the investigation + the fix: "I checked the heat pumps... I've set all the units to auto at 65°F now so it should cool down." (must contain "remotes on the wall", "I checked", "set all", "auto at 65", "cool down", room names, "same mode")
- Acknowledge the remotes + offer to check settings if still issues.
- Warm, practical, non-robotic.
- **Anti-repetition of prior host advice**: In longer threads (see full Kathryn conversation), once host side (human or auto) has already communicated the basic "Nest does not control / use wall remotes" info, subsequent AC-related follow-ups must not re-state the same core reminder paragraph. Focus on the *new* symptom + any fresh live tool action/fix. The Conversation Judge (rule 3) + conversationTraces (priorHostHVACAdvice / repeatedInstructionRisk from ConversationContextTool) will detect semantic/near-verbatim repeats of host-sent instructions anywhere in history and require REVISE to strip the duplicate while preserving new value. Brief "as previously noted" reference is ok.

**Rubric requirements**:
- Contains "remotes on the wall"
- Contains "I checked the heat pumps" (or equivalent) + "set all" + "auto at 65" (or the mode/temp the tool chose) + "cool down"
- Does NOT mention Nest or the apartment number
- Names the rooms: living room, master bedroom, small bedroom, and that they must all be on the same mode
- shouldReply: true
