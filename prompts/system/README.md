# System Prompts — Structure & Workflow

This directory manages the evolving system prompt for the Guest Messaging Agent.

## Goals

- Keep the **real production prompt** as the source of truth.
- Gradually refactor it into maintainable, reviewable, testable pieces.
- Support both rapid iteration and safe production behavior.

## Current Structure

```
prompts/
├── system/
│   ├── README.md                 # This file
│   ├── base.md                   # Current working modular base prompt (used by default)
│   ├── raw/
│   │   └── production-current.md # Verbatim full prompt imported from production
│   └── versions/                 # Versioned snapshots for experiments
├── properties/
│   ├── 1b.md
│   ├── apt2.md
│   └── apt3.md
└── categories/                   # (Future) Per-category rule files
```

## Import Workflow (Option 1)

1. User pastes the **exact full system prompt** currently sent to Grok in production.
2. It is saved verbatim into `raw/production-current.md`.
3. We analyze it together and begin modularization:
   - Core personality + principles → `base.md`
   - Category definitions and rules → eventually split into `categories/`
   - Any remaining unit-specific details → move into `properties/*.md`
4. The `GuestMessagingAgent` can load either the raw full prompt (for fidelity testing) or the modular version (for development).

## Prompt Composition (Target State)

The final system prompt sent to the model will be composed at runtime as:

```
[Core Base Prompt]
+ [Selected Category Rules]
+ [Property-Specific Knowledge for the listingId]
```

This allows us to:
- Test changes to specific categories in isolation
- Keep property rules DRY and easy to maintain
- Run evaluations against both the raw production prompt and the modular version

## Current Status (as of latest work)

- `base.md` is the core prompt (v0.2).
- Full modular category system in `categories/` (32+ files extracted from production).
- Agent supports three modes:
  1. Modular (default) — composes base + all categories + property files
  2. Raw production — load verbatim prompt via `fullPromptPath`
  3. Simple — base + property only (`useModularPrompt: false`)

- Easy comparison between raw production prompt and modular version is now possible in tests and eval runner.

## Next Steps (as of this writing)

- Import full production prompt
- Analyze and break down categories
- Implement Cancellation policy deeply
- Expand Tool system for high-rule areas (Events, Cancellations, etc.)
