# AGENTS.md — auto-reply-sqs-harness

This is the canonical instruction file for any AI/agent working in this repo (Grok, Claude, Cursor, etc.).

## Core Product
Local-first evaluation harness + core agent logic for the Grok-powered guest messaging / auto-reply system (originally the `auto-reply-sqs` Lambda).

- The "brain" (prompts + agent multipass pipeline + tools + evals) lives here.
- Real guest conversations (from Hospitable/Airbnb) are first-class test data.
- Changes are iterated locally with `npm test`, `npm run simulate`, `npm run eval`.
- Production deployment of the Lambda (`guest-messaging-agent-harness`) is **automatic on push to main** via `.github/workflows/deploy.yml` (builds zip from src/ + prompts/ + lambda/ + node_modules and calls update-function-code).
- **Commit → push = the deployment mechanism**. Never edit production directly.

## Mandatory Process for ANY Code or Doc Change
1. Make the edit(s).
2. Run relevant verification: `npm test` (must be green), and ideally `npm run eval` or targeted scenario if you touched prompts/categories/tools for HVAC, thermostat, etc.
3. `git add -A`
4. `git commit -m "Clear message describing the change and why (e.g. the user request or bug)."`
5. `git push`
6. `git status` — must be clean.
7. Verify the remote at the exact new SHA using the GitHub MCP tools (get_file_contents on the key files you edited, at the commit SHA on main branch of jeromevidaao/auto-reply-sqs-harness).
8. Only after the above is the change "done".

This rule exists because the harness directly affects live guest replies and the Lambda is auto-deployed from main. Skipping hygiene has caused production drift in the past.

## Recent Key Behaviors (as of June 2026)
- **HVAC / Heat Pump (KumoCloud)**: 
  - ThermostatTool provides per-unit static instructions + neutral language: "Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat."
  - HeatPumpTool (new) connects to the real KumoCloud v3 API using the same device serials + login as the prior production system.
  - On AC/heat complaints it fetches live per-head status (mode, roomTempF, setpoints).
  - It detects mixed modes (e.g. one head "heat" + others "cool" on Apt 2 Sunny — this is why "both remotes on but no air all night" and the unit at 80F).
  - It **auto-sets all heads** for the listing to a consistent mode (cool/auto 65°F for AC issues; heat 72°F for heating issues) and surfaces the before/after + suggested snippet so the reply can say "I checked the 3 heat pumps... one was on heat... I've set all of them to auto at 65°F now so it should cool down."
  - Works for both summer (cool) and winter (heat).
  - The first-pass LLM sees the live status + actionTaken via _buildUserPrompt enrichment; reflection/judge also receive it.
  - No more assuming the guest is "using the Nest wrongly" when they report using the remotes correctly.

- All other tools (cleaning, cancellation, event, unit readiness, conversation context) continue to work as before.
- Reflection + Conversation Judge run on (almost) every message in prod for safety.

- **Host-declared unit readiness (anti-contradiction)**: ConversationContextTool now always scans recent/prior host messages (live fetch + provided conversationHistory) for phrases indicating the host told the guest the unit is ready early ("unit is ready for you to check in now", "ready for check in", "check in now/anytime", etc.). When detected it sets `earlyUnitReadyOffered: true` + preview + trace. The first-pass prompt (_buildUserPrompt) injects a CRITICAL ANTI-CONTRADICTION block, category prompts (early-checkin, thank-you, self-checkin, welcome-messages) have explicit "scan history, never restate 4pm" rules, and the Conversation Judge (plus reflection) will REVISE/REJECT any draft that contradicts a host readiness statement by re-introducing "4pm" / "if the unit is ready earlier" language. 
  - The Taylor 9AM incident (host: "unit is ready for you to check in now" → guest: "arriving in about an hour! Thank you" → bad auto: "check-in time is 4pm...") is the canonical case. The new eval scenario `host-said-unit-ready-guest-thanks` + forbiddenPhrases in rubric will catch regressions.
  - Rule: "If we (host) told them the unit is ready, the unit is ready — do not contradict a previous statement. Conversation history + traces must prevent it."
  - Judge was augmented with specific rule + example for this class of contradiction.

## Adding / Changing HVAC Behavior
- Update language in `src/tools/hvac/ThermostatTool.js` + `prompts/system/base.md` + `prompts/system/categories/thermostat.md`.
- Update corresponding goldens + scenarios under `eval/`.
- Update the test in `tests/basic.test.js` if the warning strings change.
- For live behavior changes: edit `src/clients/KumoCloudClient.js` (mappings, login, get/set, ensureConsistent...) and `src/tools/hvac/HeatPumpTool.js` (analysis + auto-fix decision + snippet).
- Always add or update an eval scenario that exercises the exact guest wording from the real incident (e.g. "We have both of the remotes turned on and set to these settings, still no air..."). Same for host-readiness contradictions: add `host-said-unit-ready-guest-thanks.json` style scenario + golden with conversationHistory containing the contradicting host statement + forbiddenPhrases for 4pm language.
- After change: full `npm test`, commit+push+verify as above.

## Other Standing Rules
- Never hardcode secrets. Use env for local (KUMO_EMAIL etc.) or SSM in Lambda (same paths as the old production code).
- Keep the three known listings + their exact device UUIDs + serials in sync with reality (they came from the prior prod implementation).
- When you touch the live Kumo path, be extremely conservative: only act on clear temp/AC/heat complaints, only fix when you actually see a mismatch, always tell the guest what you did.
- The Kathryn Booker mixed-mode AC incident (June 2026) is the canonical example that drove the live investigation + auto-fix + neutral language change. Do not regress to accusatory "don't use the Nest" phrasing when the guest says they are on the remotes.

If you are an agent and the user asks you to make a change, you must follow the commit+push+verify steps at the end and report the SHA + MCP verification.

This file itself must be kept up to date when product behavior changes.
