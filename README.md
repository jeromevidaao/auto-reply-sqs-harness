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
    base.md                 # The main system prompt (categories, rules, tone)
  versions/                 # Versioned snapshots for experiments
src/
  agent.js                  # Core GuestMessagingAgent (the "brain")
  adapters/llm/             # pluggable LLM clients (mock + real grok)
eval/
  scenarios/                # Recorded guest situations (JSON)
  goldens/                  # Human-approved ideal responses
  runner.js                 # The evaluation harness
simulator/
  cli.js                    # Local interactive development tool
tests/                      # Fast unit + integration tests
```

## Adding a New Test Scenario (Recommended Workflow)

1. Capture a real guest message + enough context (or synthesize a good one).
2. Add it under `eval/scenarios/`.
3. Write (or let the agent generate) the ideal response in `eval/goldens/`.
4. Run `npm run eval` — the harness will score it.
5. Tweak the prompt in `prompts/system/base.md` until the agent produces high-quality output on your scenarios.
6. Commit both the scenario/golden + the prompt change.

This is how we will drive quality improvements safely.

## Current Status (v0.1)

- [x] Local-only execution (mocks by default)
- [x] Basic agent core + pluggable LLM adapter
- [x] Pluggable notification / escalation adapter
  - `console` (default for local dev) — very visible output + direct Airbnb link
  - `sns` — publishes to AWS SNS (exact same mechanism as the original production Lambda)
  - Auto mode: uses SNS if `SNS_TOPIC_ARN` / `ESCALATION_SNS_TOPIC_ARN` is set
- [x] Escalations now include a direct clickable Airbnb messages link (e.g. `https://www.airbnb.com/hosting/messages/2492335251`)
- [x] When the agent decides **not** to auto-reply, it triggers escalation (visible in simulator + via `handleMessage`)
- [x] Starting system prompt with key categories (including recent ones like `CHECKOUT_TRASH_LINEN`)
- [x] Michele inquiry scenario as the first golden test
- [x] Interactive simulator (now shows escalation behavior)
- [ ] Real email escalation adapter (to jerome.ans@gmail.com etc.)
- [ ] Full port of every rule from the original 148k monster (we will do this iteratively)
- [ ] Sophisticated rubrics + LLM-as-judge
- [ ] Shadow mode / canary helpers (later)

We are starting clean and growing the harness deliberately rather than doing a big-bang port.

## Relationship to the Original Lambda

The original `auto-reply-sqs` Lambda will **later** be refactored to become a thin consumer of this package (or a published version of the agent core). No Lambda work is happening in this repo right now.

## CI/CD & Deployment

Pushing code to the `main` branch now automatically deploys to AWS Lambda (`guest-messaging-agent-harness`).

**Important**: You must enable Branch Protection on `main` (requiring CI to pass) to avoid deploying broken code. See [docs/deployment.md](./docs/deployment.md).

## Next Steps (Iteration Plan)

See `ROADMAP.md` for the concrete backlog.

---

Built to make the guest experience consistently excellent while making the developer experience for improving the agent delightful.
