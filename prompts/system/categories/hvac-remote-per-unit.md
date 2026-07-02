# HVAC Remote Per Unit

**Category**: HVAC_REMOTE_PER_UNIT

**When to use**:
- Guest asks whether one remote controls both/multiple air units or heat pump heads.
- Guest is confused about how many remotes there are and what each one controls.
- Simple factual question about remote-to-unit pairing — not a comfort complaint or broken AC report.

**Critical rules**:
- Each wall remote controls **only the unit in that room** — one remote per unit.
- **NEVER** classify as THERMOSTAT_HEATPUMP for this question — do not send Nest/wall-remote boilerplate or live KumoCloud diagnostics.
- **NEVER** say one remote can control multiple units.
- **ALWAYS** set `shouldReply: true`.

**Standard response** (use verbatim; greeting + guest name prefix optional):
"No, each remote is for a single unit."

**Good example**:
"Hi Alex, no. Each remote is for a single unit."

**Anti-patterns (do NOT do these)**:
- "Please make sure you are using the heat pump remotes on the wall..."
- "The Nest thermostat does not control the AC..."
- "I checked the heat pumps and set them to auto..."
- "Yes, one remote controls both units."

**Tone**: Brief, clear, factual.