# Category Modules

This directory contains modular rule files extracted from the production system prompt.

Each file corresponds to one or more `typeOfMessageReceived` categories used by the agent.

## Current Categories (33 files as of latest extraction)

### High-Priority / Complex
- `cancellation.md`
- `welcome-messages.md`
- `event-request.md`

### Tools with Dedicated Logic
- Thermostat (in `ThermostatTool`)
- Cleaning issues (in `CleaningIssueTool`)

### Extracted Category Files
- `cancellation.md`
- `cancellation-exception.md`
- `checkout.md`
- `condo-comparison.md`
- `damage-report.md`
- `directions.md`
- `door-code-issues.md`
- `apt2-street-door-lockout.md` (Apt 2 only: bolted parking door + street exit lockout; SNS urgent SMS)
- `not-checkin-day-access.md` (guest at the door / can't get in **before** check-in day — Michael 2026-08-20)
- `early-checkin.md`
- `ev-charger.md`
- `event-request.md`
- `food-recommendations.md`
- `fyi-statements.md`
- `guest-count-change.md`
- `hotel-recommendation.md`
- `july-4th-fireworks.md`
- `late-checkout.md`
- `laundry.md`
- `luggage.md`
- `misc-questions.md`
- `off-platform-booking.md`
- `other-edge-cases.md`
- `outdoor-trash.md`
- `parking.md` (includes Cassidy post-checkout car: never own spot after 10am; 8pm ET + vacant sibling until 1pm only)
- `pet-policy.md`
- `pricing.md`
- `review.md`
- `check-in-instructions.md` (ahead-of-arrival entry/check-in instructions deferral with computed send date — Cynthia)
- `self-checkin.md`
- `street-safety-noise.md`
- `studio-futon.md`
- `thank-you-message.md`
- `welcome-messages.md`
- `wifi.md`

### Tools Implemented
- `ThermostatTool`
- `CleaningIssueTool`
- `CancellationTool`
- `EventRequestTool`

## Usage

**First pass** (`src/harness/categoryRouter.js`) does **not** load every file.

- Never: `conversation-judge.md`, `reflection.md` (reviewer-only)
- Always: `thank-you-message.md`, `fyi-statements.md`
- Plus at most 4 routed files from keyword + tool signals
- Fallback ops pack (`welcome-messages`, `checkout`, `self-checkin`, `parking`) only when nothing matches

**Reviewer pass** concatenates `conversation-judge.md` + `reflection.md` (`composeReviewerPrompt`) on `grok-3-mini`.

When adding new categories:
1. Create a new `.md` file with clear rules and example responses.
2. Add a router rule in `src/harness/categoryRouter.js` (file + test regex / tool signal).
3. Update this README.
4. (Optional) Create a corresponding `Tool` if the logic is complex or needs side effects.
5. Add a claim-check rule in `src/harness/claimCheck.js` if the category has tool-grounded facts.

## Extraction Status

Extracted from production Lambda source (2026-05-28 paste).

Goal: Extract **all** categories from the original prompt into maintainable files.
