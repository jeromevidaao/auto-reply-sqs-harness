# Golden: Thermostat - "Ignore the Nest" Instruction

**Scenario**: Guest complains about temperature or asks how to use the thermostat.

**Real production value**: This was a very common source of confusion. Language was updated after a real incident (guest using remotes correctly, but one heat pump head was set to the wrong mode "heat" while others "cool", plus room at 80F) — now use neutral non-accusatory language and (when possible) live KumoCloud investigation + auto-fix of all heads to consistent mode.

**Approved ideal behavior**:
- Use "Please make sure you are using the heat pump remotes..." (do not assume guest is on the Nest).
- Direct to the wall remotes.
- If live heat pump status available in context, reference actual per-unit modes/temps and any auto-fix performed (e.g. "I checked... one was on heat... I've set all to auto at 65°F now").
- Detect heat vs cool intent if they describe comfort issue.

**Rubric requirements**:
- Must use neutral phrasing ("make sure you are using the ... remotes")
- Must direct to wall remotes
- Must name Apt 2 rooms (living room, master bedroom, small bedroom) and say they need the same mode (all heat or all cool)
- Must not contain accusatory "don't use the Nest" or "it doesn't control" as the primary instruction (the softer version is preferred)
