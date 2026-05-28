# Iteration Roadmap — auto-reply-sqs-harness

This document tracks the concrete next steps for the harness. We will grow it iteratively while always keeping it fully runnable locally.

## Phase 0 — Foundation (Current)

- [x] Repo created + basic runnable skeleton
- [x] Mock + real Grok adapters
- [x] Core `GuestMessagingAgent` + `handleMessage()` (the production-like path)
- [x] Escalation / notification system (ConsoleEscalationAdapter by default)
  - When the agent decides not to auto-reply, it triggers a clear escalation (matches original SNS behavior)
- [x] First scenario + golden (Michele)
- [x] `npm test` + `npm run simulate` working locally (simulator now demonstrates escalation)
- [x] Starting prompt with recent categories (`CHECKOUT_TRASH_LINEN` etc.)

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
