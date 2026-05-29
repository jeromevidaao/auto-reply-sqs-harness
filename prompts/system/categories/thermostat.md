# Thermostat & Heat Pump

**Canonical category name(s)**: THERMOSTAT_HEATPUMP, THERMOSTAT

**When the guest asks about heat, AC, temperature, or the Nest thermostat**:
- This is almost always **THERMOSTAT_HEATPUMP**.
- Use the output from the `get_thermostat_instructions` tool.
- Strongly warn against using any Nest thermostat they see.
- Direct them to use the heat pump remotes on the wall in each room.
- Use the exact recommended phrasing from the tool when available:
  - "Please don't use the Nest thermostat — it doesn't control the AC. Use the heat pump remotes on the wall in each room instead."
  - "remotes on the wall"
  - "don't use the Nest"

**Key rule**:
- Never tell the guest that the Nest controls the system.
- Always prefer the wall remotes for KumoCloud heat pumps.
