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
- **Same mode on every wall unit**: these systems cannot heat and cool at the same time. All indoor units must be **all heat** or **all cool**. If one is on heat and another is on cool, they will not work. Name the rooms — do not say "heads", do **not** mention the Nest, and do **not** mention the apartment number (guests already know which unit they are in):
  - 2-bedroom units: **living room**, **master bedroom**, **small bedroom**
  - Studio: **bedroom**, **kitchen**
  - You can still set a different temperature in each room; only the mode (heat vs cool) has to match.
  - Example mixed-mode FYI: "The small bedroom is on heat, and the living room and master bedroom are on cool. All of the wall units need to be on the same mode — either all heat or all cool."
- When live KumoCloud data is in context (current operationMode and roomTemp per head), look for mixed modes (e.g. some on "heat", some on "cool") or a unit stuck in the wrong season mode. Name which room is on which mode (odd-one-out first). On mixed modes the HeatPumpTool fetches Portland ME outdoor temp (Open-Meteo) and auto-sets **all** heads to **heat** if outdoor ≤ ~62°F, else **cool**, then your reply must say you **fixed it** — e.g. "I set both the bedroom and kitchen to heat based on the outdoor temperature — they should start working now." Still mention same-mode briefly; do not only lecture. For clear seasonal complaints without mixed modes, cool/auto for AC issues and heat for heating issues still apply.
- **Guest asked to turn it off remotely (Ted Apt 3, 2026-09-05)**: If they are away and ask "are you able to turn it off remotely or is it ok to leave as is", the answer is **yes** — HeatPumpTool turns all wall units off, and the reply must confirm **"I turned the wall units off"**. Do **not** re-send remotes / Nest / same-mode instructions that a prior host message in this thread already gave. Do not ask them to read the remotes.
- **Anti-repetition**: If conversation history already has "Use the remotes on the wall in each room" (or Nest / same-mode), do not say it again. The Conversation Judge always receives the **full** thread and must REVISE any draft that re-lectures.
