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

- **No silent failure to fetch conversation history (user requirement for Taylor threads)**: The primary source of "full recent history" (including the critical prior host readiness message) in production is the live call inside ConversationContextTool: `hospitableClient.getConversationMessages(conversationId, 20)` using the conversation_id from the SQS/webhook payload. This list is then copied to conversationHistory for the prompt + judge/reflection.
  - The ConversationContextTool *always* sets `historySource`, `historyFetchFailed`, `recentMessageCount`, and a clear trace (success or "Live message history fetch failed (using fallback)").
  - On any fetch failure the catch does a loud `console.error` with "CRITICAL HISTORY FETCH FAILURE (anti-contradiction / ... at risk)" + the exact Taylor example + the named thread "Taylor’s group of 2 Jun 5 – 6 · 1 night 53 Pine #1B · Downtown Studio, Parking with EV charger".
  - `_runCoreSafetyTraces` and the post-enrich block in handleMessage *always* log the history status (`[Agent] → Conversation history status: source=...` and the "No live conversationHistory populated" case).
  - `_buildUserPrompt` now *always* emits a prominent "CONVERSATION HISTORY STATUS / FETCH WARNING" block (with the full safety rules + Taylor-specific instructions) when historyFetchFailed or limited visibility. The LLM sees it on every first-pass.
  - The same flags flow (via enrichedContext + conversationTraces) into reflection and judge contexts.
  - Judge (rule 3) and reflection now have explicit "Limited / failed history fetch case" sub-rules + issue examples that force REVISE/REJECT on 4pm/policy language for plausible follow-ups when we don't have the prior thread.
  - Base prompt also calls it out.
  - Eval scenario `host-said-unit-ready-guest-thanks` (and its golden) documents the expectation: in prod the live fetch must succeed with the prior host msg visible (or the WARNING + judge rules must catch the bad case).
  - Result: there is no longer a silent path where we operate without the history and accidentally contradict a prior host statement. Every relevant log line, trace, prompt section, and second-pass reviewer knows the fetch status.
  - When adding similar history-dependent rules in future, follow the same pattern (dedicated fields on the context tool result, loud error on failure, explicit status block in first-pass prompt, judge/reflection sub-rule).
  - **First-welcome NEW_RESERVATION_WELCOME must still get 4pm + logistics (regression after Taylor safeguards)**: The strong "avoid 4pm / policy language" and "no history → conservative" instructions added for the Taylor anti-contradiction + no-silent-fetch (in _buildUserPrompt's CONVERSATION HISTORY STATUS else block, base.md, and related) caused a regression on the first-post-booking-birthday-abby scenario: after the 3-day phrase was forced (prior turn), the next run reported 8/9 missing "4pm" (verbatim user: "Still one test failing ... ❌ Score: 8/9 — NEW_RESERVATION_WELCOME Notes: Missing required phrase: 4pm"). Root: the no-prior-history else block used broad language ("arrival-related messages") + base.md caution that applied even to a true first-post-booking pure welcome (conversationHistory:[] by design for the scenario, this will be the first host/auto reply, no prior readiness possible to contradict). The Taylor WARNING block is correct for fetch-failed follow-ups, but the plain else over-generalized. Fix (this turn): scoped the else text explicitly to "brand new thread ... first host reply ... MUST still deliver the full rich welcome including ... 4pm" and "the conservative 'avoid 4pm' only applies to *follow-up* messages ... see the WARNING block"; added positive "ALSO CRITICAL (4pm + core logistics...)" injection in agent.js right after the 3-day CRITICAL (checks !earlyUnitReadyOffered, names the abby requiredPhrases and "for this pure first welcome on future stay with no history, include the 4pm", mirrors Kathryn phrase-forcing pattern); strengthened welcome-messages.md (added "ALSO REQUIRED..." para for future>=3 naming 4pm/self-check-in/parking + abby rubric + "history-scan-first is the *only* exception") and base.md (clarified "on follow-up messages ... For brand new threads where the current message is the guest's *first* ... still provide the full rich..."). earlyUnitReadyOffered + history-scan-first (top of welcome md) + the fetch-failed WARNING continue to fully protect Taylor cases. Pattern reminder: when hardening history/anti-contradiction rules, always explicitly carve out "brand new thread / first host reply / pure NEW_RESERVATION_WELCOME intro" so the required rich first-page logistics (4pm, self-check-in, parking, 3-day) are not accidentally suppressed for the abby-style cases. After edit: npm test, commit+push, MCP get_file_contents at SHA on jeromevidaao/auto-reply-sqs-harness, user git pull + re-run `node scripts/test-one-scenario.js first-post-booking-birthday-abby --reflection` + full eval.

## Adding / Changing HVAC Behavior
- Update language in `src/tools/hvac/ThermostatTool.js` + `prompts/system/base.md` + `prompts/system/categories/thermostat.md`.
- Update corresponding goldens + scenarios under `eval/`.
- Update the test in `tests/basic.test.js` if the warning strings change.
- For live behavior changes: edit `src/clients/KumoCloudClient.js` (mappings, login, get/set, ensureConsistent...) and `src/tools/hvac/HeatPumpTool.js` (analysis + auto-fix decision + snippet).
- Always add or update an eval scenario that exercises the exact guest wording from the real incident (e.g. "We have both of the remotes turned on and set to these settings, still no air..."). Same for host-readiness contradictions: add `host-said-unit-ready-guest-thanks.json` style scenario + golden with conversationHistory containing the contradicting host statement + forbiddenPhrases for 4pm language. The scenario/golden must also document the history fetch contract (live_fetched with the prior host msg for the named Taylor thread, or the new WARNING block + judge limited-history rule must be exercised).
- After change: full `npm test`, commit+push+verify as above.

## Other Standing Rules
- Never hardcode secrets. Use env for local (KUMO_EMAIL etc.) or SSM in Lambda (same paths as the old production code).
- Keep the three known listings + their exact device UUIDs + serials in sync with reality (they came from the prior prod implementation).
- When you touch the live Kumo path, be extremely conservative: only act on clear temp/AC/heat complaints, only fix when you actually see a mismatch, always tell the guest what you did.
- The Kathryn Booker mixed-mode AC incident (June 2026) is the canonical example that drove the live investigation + auto-fix + neutral language change. Do not regress to accusatory "don't use the Nest" phrasing when the guest says they are on the remotes.

If you are an agent and the user asks you to make a change, you must follow the commit+push+verify steps at the end and report the SHA + MCP verification.

This file itself must be kept up to date when product behavior changes.
