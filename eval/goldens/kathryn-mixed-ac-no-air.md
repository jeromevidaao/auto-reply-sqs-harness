# Golden: Kathryn mixed-mode AC "no air" (live Kumo auto-fix)

**Scenario**: Follow-up message after initial AC complaint. Guest explicitly says the remotes are on with settings, still no air all night. (Apt 2 / Sunny — 3 heads.)

**Real incident context**:
- Guest was correctly using the wall remotes.
- One indoor head was set to "heat", the other two to "cool" (or auto?); the mismatched head was ~80F hot.
- Heat pumps cannot simultaneously heat and cool different zones — this is why "on but no air".
- Host manually diagnosed via Kumo app, set all three to auto at 65°F, and explained.

**Approved ideal behavior (post HeatPumpTool)**:
- Use neutral "Please make sure you are using the heat pump remotes..." (never "don't use the Nest — you're doing it wrong").
- The live tool will have already fetched status and auto-set all heads.
- Reply must include neutral reminder: "Please make sure you are using the heat pump remotes on the wall in each room" (or close) + reference the investigation + the fix: "I checked the heat pumps... I've set all the units to auto at 65°F now so it should cool down." (must contain "make sure you are using", "remotes on the wall", "I checked", "set all", "auto at 65", "cool down")
- Acknowledge the remotes + offer to check settings if still issues.
- Warm, practical, non-robotic.

**Rubric requirements**:
- Contains "make sure you are using the ... remotes on the wall"
- Contains "I checked the heat pumps" (or equivalent) + "set all" + "auto at 65" (or the mode/temp the tool chose) + "cool down"
- Does NOT contain accusatory "don't use the Nest" phrasing
- Mentions that the system cannot cool+heat at the same time (or equivalent diagnosis)
- shouldReply: true
