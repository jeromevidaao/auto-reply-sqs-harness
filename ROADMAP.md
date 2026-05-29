# Iteration Roadmap — auto-reply-sqs-harness

This document tracks the concrete next steps for the harness. We will grow it iteratively while always keeping it fully runnable locally.

## Phase 0 — Foundation (Completed)

- [x] Repo created + basic runnable skeleton
- [x] Mock + real Grok adapters
- [x] Core `GuestMessagingAgent` + `handleMessage()`
- [x] Escalation / notification system
- [x] Tool abstraction (`BaseTool` + `ToolRegistry`)
- [x] CleaningIssueTool + ThermostatTool
- [x] Property-specific knowledge extraction
- [x] CI/CD via GitHub Actions + OIDC
- [x] SQS cutover to harness Lambda

## Phase 1 — Production Prompt Import & Modularization (In Progress - "A to E")

**Goal**: Bring the real production brain into the harness using clean architecture.

### A. Deep Prompt Extraction & Modularization (Largely Complete)
- [x] Received full production Lambda source (2026-05-28)
- [x] 32 category modules extracted from production
- [x] Clean core `base.md` (v0.2) + smart prompt composition
- [x] Agent supports raw production vs modular modes with easy switching
- [x] Integration tests for prompt loading + comparison
- Next: Smarter category selection (instead of loading all 32 every time) + prompt versioning

### B. Cancellation Policy (Highest Risk)
- [x] Created `categories/cancellation.md`
- [x] Implemented `CancellationTool` with history-aware escalation detection
- [x] Wired into `GuestMessagingAgent.handleMessage`
- [x] Basic reflection / second-pass capability implemented
- [x] Conversation Judge implemented (stronger anti-repetition & consistency reviewer)
- [ ] Full refund timing logic + stronger anti-contradiction in reflection pass (next)

### C. EventRequestTool
- [x] Created `categories/event-request.md`
- [x] Implemented `EventRequestTool`
- [x] Wired into agent

### E. Evaluation Hardening
- [x] Added Josh cleaning complaint scenario + golden (real production thread)
- [x] Multiple new Tools wired into production path (Cancellation, EventRequest)
- [x] Added 5 new goldens exercising advanced old production behaviors
- [x] Added 3 high-value **real** production scenarios directly extracted from the old monolithic code:
  - Wrong entrance / gas station path (recurring real guest confusion for Apt 2)
  - Snow plowing service (real winter operational question)
  - Cleaning team using parking on same-day turnover (real operational case)
- [x] Eval now at 42 scenarios / 214/214 rubric score — all pass locally with mock LLM (npm test + npm run eval both fully green)
- Extremely strong emphasis on porting real historical / operational scenarios directly mined from the old monolithic production code

### Phase 2 — Solid Multipass System (Current Focus)
- [x] ConversationContextTool added for early trace enrichment (pre-approval detection, recent host messages)
- [x] Richer traces now injected into main LLM prompt, Reflection, and Conversation Judge
- [x] **Dedicated early "Pre-processing / Trace Enrichment" step** added at the very start of `handleMessage`
  - Runs lightweight safety/trace tools *before* the first LLM call (`processMessage`)
  - Ensures the main generation pass already benefits from the best possible signals
- [x] `ConversationContextTool` enhanced with real pre-approval detection logic (using Hospitable inquiry + messages)
- [x] Cheap early UnitReadiness trace added for check-in day messages
- [x] Explicit escalation forcing for risky cancellations (prior host statements, exception requests, or recent host activity + cancellation talk)
  - Any cancellation conversation with risk signals now triggers an email to jerome.ans@gmail.com with the direct Airbnb conversation URL
- Tool results and safety traces (pre-approval, recent host activity, unit readiness) available earlier in the pipeline
- Next: Continue moving remaining old production safety logic (full duplicate checks, more pre-approval details) into the tool layer
- Goal: Highest quality responses by ensuring every pass (main + reflection + judge) has the best possible traces and tool outputs
- Improve _buildUserPrompt and reflection/judge prompts to leverage the new traces more effectively
- [x] Added preapproved-inquiry-fastpath golden that exercises early pre-approval trace injection into the first LLM pass
- [x] Significantly enhanced ConversationContextTool with stronger live duplicate/recent host message checking (actively fetches via Hospitable when possible + content similarity heuristic)
- Add more goldens specifically testing multipass behavior (recent host suppression, judge forcing revisions based on traces)

### D. Welcome Message Logic
- [x] Basic NEW_RESERVATION_WELCOME + pet mismatch golden added and passing
- [ ] Improve dynamic parts (pet mismatch, availability, early check-in timing, unit readiness) with more edge cases
- [ ] Add NEW_INQUIRY_WELCOME golden with availability check

### E. Evaluation Hardening (ongoing)
- [x] Eval scenarios expanded from 2 → 4
- [ ] Continue incremental addition of goldens for the remaining high-risk categories from the original 65
- [ ] Target: 8–10 goldens before next production deploy of significant prompt/Tool changes
- [ ] Improve eval runner (better diffing, category coverage report)

**Guiding principle**: No change goes near production until it can be validated locally against the real prompt + goldens.

## Phase 1 — Make the Real Prompt Usable

- [ ] Create a script that can extract the current production system prompt from the original repo (or take a pasted version)
- [ ] Split the giant prompt into modular, reviewable sections (base rules + per-category files)
- [ ] Add prompt versioning + loader
- [ ] Make the Michele test + 3–4 more real scenarios pass cleanly against the extracted prompt

## Phase 2 — Better Evaluation

- [ ] Structured rubrics (accuracy, tone, policy, conciseness)
- [ ] Simple diff reporter between prompt versions
- [ ] Ability to run evals against both `grok-4.3` and `grok-3-mini` for comparison
- [ ] Record/replay for expensive real-model calls during development

## Phase 3 — Developer Experience

- [ ] Excellent simulator with context injection UI
- [ ] "Explain why" mode (show full reasoning + which rules fired)
- [ ] One-command "try this prompt change against all goldens"
- [ ] Markdown/HTML eval reports

## Phase 4 — Bridge to Production (Later)

- [ ] Thin Lambda wrapper that imports the agent from this package (or a published version)
- [ ] Shadow mode tooling
- [ ] Automated regression gate in CI for the original repo

---

**Guiding rule**: If a change cannot be validated quickly and safely in this harness using only local commands, it is not ready to go near real guest messages.
