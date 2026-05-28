# Category Modules

This directory contains modular rule files extracted from the production system prompt.

Each file corresponds to one or more `typeOfMessageReceived` categories used by the agent.

## Current Categories (32 files as of latest extraction)

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
- `early-checkin.md`
- `ev-charger.md`
- `event-request.md`
- `food-recommendations.md`
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
- `parking.md`
- `pet-policy.md`
- `pricing.md`
- `review.md`
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

The `GuestMessagingAgent` loads all `.md` files in this directory and includes them in the composed system prompt.

When adding new categories:
1. Create a new `.md` file with clear rules and example responses.
2. Update this README.
3. (Optional) Create a corresponding `Tool` if the logic is complex or needs side effects.

## Extraction Status

Extracted from production Lambda source (2026-05-28 paste).

Goal: Extract **all** categories from the original prompt into maintainable files.
