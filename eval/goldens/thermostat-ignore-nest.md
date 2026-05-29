# Golden: Thermostat - "Ignore the Nest" Instruction

**Scenario**: Guest complains about temperature or asks how to use the thermostat.

**Real production value**: This was a very common source of confusion. Old code had strong, repeated instruction: Do NOT use the Nest — use the heat pump remotes on the wall in each room.

**Approved ideal behavior**:
- Clearly tell them not to use the Nest.
- Direct them to the wall remotes.
- Detect heat vs cool intent if they describe comfort issue.

**Rubric requirements**:
- Must explicitly say not to use the Nest
- Must direct to wall remotes
