# Thermostat & Heat Pump

**Canonical category name(s)**: THERMOSTAT_HEATPUMP, THERMOSTAT

**Do NOT use THERMOSTAT_HEATPUMP when the guest only asks whether one remote controls both/multiple air units** (e.g. "Does the one remote work both air units?"). That is **HVAC_REMOTE_PER_UNIT** — answer that each remote is for a single unit. See hvac-remote-per-unit.md.

**When the guest asks about heat, AC, temperature, or the Nest thermostat**:
- This is almost always **THERMOSTAT_HEATPUMP**.
- Use the output from the `get_thermostat_instructions` tool (and live `get_heat_pump_status` when a comfort complaint is present).
- Do **not** assume the guest is using the wrong thing (e.g. the Nest). Use neutral "make sure" language from the tool.
- Use the exact recommended phrasing from the tool when available:
  - "Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat."
  - "remotes on the wall"

**Key rules**:
- Never tell the guest that the Nest controls the system.
- Always prefer the wall remotes for KumoCloud heat pumps.
- **Same mode on every wall unit**: these systems cannot heat and cool at the same time. All indoor units must be **all heat** or **all cool**. If one is on heat and another is on cool, they will not work. Name the rooms — do not say "heads":
  - Apt 2 and Apt 3: **living room**, **master bedroom**, **small bedroom**
  - Apt 1B: **bedroom**, **kitchen**
  - You can still set a different temperature in each room; only the mode (heat vs cool) has to match.
- When live KumoCloud data is in context (current operationMode and roomTemp per head), look for mixed modes (e.g. some on "heat", some on "cool") or a unit stuck in the wrong season mode. Name which room is on which mode. The HeatPumpTool will auto-set all heads to a consistent mode (cool/auto for AC issues, heat for heating issues) and provide the before/after so your reply can say "I checked the 3 heat pumps — the living room was on heat while the master bedroom and small bedroom were on cool (and the room was 80°F). All of the wall units need to be on the same mode. I've set all of them to auto at 65°F now; it should start cooling down."
