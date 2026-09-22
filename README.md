# auto-reply-sqs-harness

**Local-first evaluation harness + core agent** for the Grok-powered guest messaging system (originally `auto-reply-sqs`).

The goal is to let you **rapidly iterate on prompt quality, new categories, tone, policy, and model choices** with zero deployment friction and no AWS dependencies for day-to-day work.

Everything important runs 100% locally.

## Philosophy

- The "brain" (prompts + agent logic + evaluation) lives here.
- The AWS Lambda becomes a thin adapter later (future work).
- Real guest conversations are precious. We treat them as first-class test data.
- Prompt changes should be reviewable, versioned, and testable before they ever touch production traffic.

## Quick Start (Fully Local)

```bash
git clone git@github.com:jeromevidaao/auto-reply-sqs-harness.git
cd auto-reply-sqs-harness

npm install

# Run the baseline test suite (uses only mocks — no API keys required)
npm test

# Launch the interactive simulator (also mock by default)
npm run simulate
```

## Running with a Real Grok Model (Optional)

1. Copy the example env:
   ```bash
   cp .env.example .env
   ```

2. Put your Grok API key in `.env`:
   ```
   GROK_API_KEY=your_key_here
   ```

3. The simulator and eval runner will automatically use the real model when the key is present (and fall back gracefully).

## Key Commands

| Command            | What it does                                      |
|--------------------|---------------------------------------------------|
| `npm test`         | Run all automated tests (goldens + regressions)   |
| `npm run simulate` | Interactive local REPL to talk to the agent       |
| `npm run eval`     | Run the full evaluation suite against scenarios   |
| `npm run eval:report` | Same as above + write a human-readable report  |

## Project Layout

```
prompts/
  system/
    base.md                 # Core prompt
    categories/             # 34 modular category rule files (real production scenarios heavily represented)
    raw/                    # Original monolithic prompt for comparison
  properties/               # Per-unit knowledge

src/
  harness/                  # Category router, first-pass compose, claim check, draft vs reviewer models
  agent.js                  # GuestMessagingAgent (traces → routed grok-4.7 draft → claim check → merged grok-3-mini reviewer)
  tools/                    # Rich tool system (Cancellation, Thermostat + Live HeatPump/KumoCloud with auto-fix of mixed modes, UnitReadiness, ConversationContext, etc.)
  clients/                  # HospitableClient, KumoCloudClient (live status + control for the 3 Apt heat pumps)

eval/
  scenarios/                # 43 goldens (many are real production scenarios)
  goldens/
  runner.js

simulator/
  cli.js

tests/
```

## Adding a New Test Scenario (Recommended Workflow)

We treat real guest conversations as first-class test data.

1. Capture a real guest message + rich context (highly preferred) or create a high-value synthetic one.
2. Add the scenario under `eval/scenarios/`.
3. Write the ideal response + clear rubric in `eval/goldens/`.
4. Run `npm run eval`.
5. Improve prompts, tools, or early trace enrichment until the multipass system produces excellent output.
6. Commit the scenario + golden together with any agent/prompt changes.

This is the primary way we drive response quality.

## Production Prompt & Modularization

We have already done a large extraction of the original monolithic prompt into modular category files (see `prompts/system/categories/`). 

The raw original is preserved in `prompts/system/raw/` for comparison and regression testing.

Ongoing work focuses on refining the modular prompts + the multipass agent logic that uses them.

## Current State

- [x] Fully local execution (mocks by default, real Grok supported)
- [x] Mature core agent with pluggable LLM + notification adapters
- [x] Rich Tool system (`BaseTool` + `ToolRegistry`) — Cleaning, Thermostat + **Live HeatPumpTool** (KumoCloud API: fetches real per-head mode/roomTemp, detects mixed cool/heat across units, auto-sets all heads to consistent mode+temp on AC/heat complaints, surfaces "I checked... I've set them to..." for the reply), Cancellation (+ live policy), Event, UnitReadiness, ConversationContext, etc.
- [x] Sophisticated multipass response system:
  - Early "Pre-processing / Trace Enrichment" step (pre-approval detection, recent host activity, duplicate risk, unit readiness hints)
  - Main LLM generation with rich traces
  - Reflection pass (high-risk categories)
  - Conversation Judge (anti-repetition + consistency, runs on nearly every message)
- [x] 43 goldens (heavy emphasis on real production scenarios extracted from the original monolithic Lambda)
- [x] Strong focus on leveraging traces + tools for highest-quality responses
- [x] 34 modular category rule files + property-specific knowledge
- [x] Full evaluation harness with rubrics (`npm run eval`)
- [x] Rich CloudWatch-style tracing in production Lambda handler
- [x] CI runs full test + eval on every push

The harness is now the primary place where response quality is developed and validated.

## Relationship to the Original Lambda

The core agent and evaluation harness now live here. The original Lambda has been updated to consume this package as its brain (thin handler + rich logging + OIDC deployment).

Most quality and safety work happens in this repository.

## CI/CD & Deployment

Pushing to `main` runs the full test + eval suite in CI and (if passing) deploys to the `guest-messaging-agent-harness` Lambda via GitHub OIDC.

Branch protection requiring CI + eval to pass is strongly recommended. See `docs/deployment.md`.

## Current Focus & Next Steps

See `ROADMAP.md` for the live backlog.

Current emphasis:
- Continuing to harden the multipass system (early trace enrichment, better use of tools + conversation history across all passes)
- Porting more high-value real production scenarios as goldens
- Moving remaining old safety logic (duplicate checks, pre-approval fast paths, etc.) into reusable tools

The goal is the highest quality responses possible by ensuring every pass in the pipeline has excellent traces and tool outputs.

---

Built to make the guest experience consistently excellent while making the developer experience for improving the agent delightful.

## Repository Privacy

Switching all repositories to private is a GitHub account setting change performed outside the UI or API and is explicitly out of scope for code edits in this harness.
