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
- [x] Basic reflection / second-pass capability implemented (lightweight critique for high-risk categories)
- [ ] Full refund timing logic + stronger anti-contradiction in reflection pass (next)

### C. EventRequestTool
- [x] Created `categories/event-request.md`
- [x] Implemented `EventRequestTool`
- [x] Wired into agent

### E. Evaluation Hardening
- [x] Added Josh cleaning complaint scenario + golden (real production thread)
- [x] Multiple new Tools wired into production path (Cancellation, EventRequest)

### D. Welcome Message Logic
- [ ] Improve `NEW_RESERVATION_WELCOME` and `NEW_INQUIRY_WELCOME`
- [ ] Make dynamic parts (pet mismatch, availability, early check-in) more robust

### E. Evaluation Hardening
- [ ] Add real production goldens (start with Josh cleaning thread)
- [ ] Expand eval scenarios
- [ ] Improve eval runner with rubrics

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
