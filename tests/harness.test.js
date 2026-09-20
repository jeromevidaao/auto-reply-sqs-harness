import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  ALWAYS_CORE_FILES,
  FALLBACK_OPS_FILES,
  MAX_ROUTED,
  REVIEWER_CATEGORY_FILES,
  routeCategoryFiles,
  checkDraftClaims,
  shouldSkipLlmJudge,
  clearPromptCache,
  composeFirstPassPrompt,
  DRAFT_TEMPERATURE,
  REVIEWER_MODEL,
  DRAFT_MODEL,
} from '../src/harness/index.js';
import { GrokLLMAdapter } from '../src/adapters/llm/grok.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

describe('category router', () => {
  it('never selects reviewer files', () => {
    const { files } = routeCategoryFiles({
      guestMessage: 'Please cancel and also the judge should not load',
    });
    assert.ok(files.every((f) => !REVIEWER_CATEGORY_FILES.has(f)));
  });

  it('always includes thanks + FYI core', () => {
    const { files } = routeCategoryFiles({ guestMessage: 'Where is parking?' });
    for (const core of ALWAYS_CORE_FILES) {
      assert.ok(files.includes(core), `missing core ${core}`);
    }
  });

  it('routes parking asks to parking.md and caps extras', () => {
    const { files } = routeCategoryFiles({
      guestMessage: 'Can we leave the car after checkout in our spot?',
    });
    assert.ok(files.includes('parking.md'));
    const extras = files.filter((f) => !ALWAYS_CORE_FILES.includes(f));
    assert.ok(extras.length <= MAX_ROUTED + 2, `too many extras: ${extras.join(',')}`);
  });

  it('routes towels+toiletries to misc-questions not extra linens', () => {
    const { files } = routeCategoryFiles({
      guestMessage: 'Do you provide towels and toiletries?',
    });
    assert.ok(files.includes('misc-questions.md'));
    assert.ok(!files.includes('extra-linens-towels.md'));
  });

  it('routes coffee maker / Keurig to misc-questions', () => {
    const { files } = routeCategoryFiles({
      guestMessage: 'What coffee maker do you have in the apartment?',
    });
    assert.ok(files.includes('misc-questions.md'));
  });

  it('routes "cancellation options" to cancellation.md', () => {
    const { files } = routeCategoryFiles({
      guestMessage: "I'm wondering what our cancellation options are.",
    });
    assert.ok(files.includes('cancellation.md'));
  });

  it('routes noisy-at-night to street-safety-noise.md', () => {
    const { files } = routeCategoryFiles({
      guestMessage: "Is the area noisy at night? We're light sleepers.",
    });
    assert.ok(files.includes('street-safety-noise.md'));
  });

  it('routes book-directly-to-avoid-fees to off-platform-booking.md', () => {
    const { files } = routeCategoryFiles({
      guestMessage: 'Can we book directly with you to avoid fees?',
    });
    assert.ok(files.includes('off-platform-booking.md'));
  });

  it('routes check out a bit later to late-checkout.md', () => {
    const { files } = routeCategoryFiles({
      guestMessage: 'Is it possible to check out a bit later, maybe 12 or 1pm?',
    });
    assert.ok(files.includes('late-checkout.md'));
  });

  it('does not treat "in the unlikely event" as event-request', () => {
    const { files } = routeCategoryFiles({
      guestMessage:
        'In the unlikely event that our very senior dog is still around for Thanksgiving, will that be an issue given your 2 dog max?',
    });
    assert.ok(files.includes('pet-policy.md'));
    assert.ok(!files.includes('event-request.md'));
  });

  it('uses fallback ops when there is no signal, but not on short thanks', () => {
    const unclear = routeCategoryFiles({ guestMessage: 'asdfghjkl random nonsense qwerty' });
    assert.equal(unclear.usedFallback, true);
    for (const f of FALLBACK_OPS_FILES) {
      assert.ok(unclear.files.includes(f), `fallback missing ${f}`);
    }
    const thanks = routeCategoryFiles({
      guestMessage: 'Thanks!',
      context: {
        conversationTraces: { hasRecentHostMessage: true, recentWelcomeSent: true },
        conversationHistory: [{ sender_type: 'host', body: 'Welcome, check-in is 4pm.' }],
      },
    });
    assert.equal(thanks.usedFallback, false);
    assert.ok(!thanks.files.includes('welcome-messages.md'));
  });
});

describe('claim check', () => {
  it('flags 4pm after the host said the unit is ready', () => {
    const result = checkDraftClaims({
      draft: 'You are welcome. Check-in time is 4pm.',
      guestMessage: 'Arriving in about an hour, thank you!',
      context: { conversationTraces: { earlyUnitReadyOffered: true } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'ready_vs_4pm'));
    assert.ok(result.revisedResponse);
    assert.ok(!/4\s*pm/i.test(result.revisedResponse));
  });

  it('flags a 475 link on an already-cancelled reservation', () => {
    const result = checkDraftClaims({
      draft: 'Please see https://www.airbnb.com/help/article/475 for options.',
      guestMessage: 'I had to cancel for medical reasons.',
      context: { reservationStatus: 'cancelled' },
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'policy_475_forbidden'));
  });

  it('flags the events decline on a third-dog ask', () => {
    const result = checkDraftClaims({
      draft: 'Unfortunately we are not able to accommodate events or gatherings.',
      guestMessage:
        'In the unlikely event that our very senior dog is still around for Thanksgiving, will that be an issue given your 2 dog max?',
    });
    assert.ok(result.issues.some((i) => i.code === 'event_false_positive'));
    assert.ok(result.issues.some((i) => i.code === 'pet_over_max_missing'));
  });

  it('flags fabricated stay-extension availability', () => {
    const result = checkDraftClaims({
      draft: 'Those dates are available — you are all set to extend.',
      guestMessage: 'Can we stay one extra night?',
      toolResults: {
        stayExtension: { detected: true, calendarChecked: true, allAvailable: false },
      },
    });
    assert.ok(result.issues.some((i) => i.code === 'calendar_false_open'));
  });
});

describe('skip LLM judge', () => {
  it('skips when a deterministic rewrite already passed claims', () => {
    assert.equal(
      shouldSkipLlmJudge({
        decision: { typeOfMessageReceived: 'PET_QUESTIONS', deterministicRewrite: true },
        claimCheck: { ok: true },
        context: {},
      }),
      true
    );
  });

  it('never skips cancellations', () => {
    assert.equal(
      shouldSkipLlmJudge({
        decision: { typeOfMessageReceived: 'CANCELLATION_POLICY', deterministicRewrite: true },
        claimCheck: { ok: true },
        context: {},
      }),
      false
    );
  });

  it('does not skip when claims still fail', () => {
    assert.equal(
      shouldSkipLlmJudge({
        decision: { typeOfMessageReceived: 'STAY_EXTENSION', deterministicRewrite: true },
        claimCheck: { ok: false, okAfterFixes: false },
        context: {},
      }),
      false
    );
  });

  it('does not skip when the thread already has conversation history', () => {
    assert.equal(
      shouldSkipLlmJudge({
        decision: { typeOfMessageReceived: 'THERMOSTAT_HEATPUMP', deterministicRewrite: true },
        claimCheck: { ok: true },
        context: {
          conversationHistory: [
            { sender_type: 'host', body: 'Use the remotes on the wall in each room.' },
          ],
        },
      }),
      false
    );
  });

  it('does not skip HVAC even on a first how-to', () => {
    assert.equal(
      shouldSkipLlmJudge({
        decision: { typeOfMessageReceived: 'THERMOSTAT_HEATPUMP', deterministicRewrite: true },
        claimCheck: { ok: true },
        context: {},
      }),
      false
    );
  });
});

describe('first-pass prompt compose', () => {
  beforeEach(() => clearPromptCache());

  it('omits conversation-judge and reflection from the writer prompt', async () => {
    const composed = await composeFirstPassPrompt({
      promptPath: path.join(projectRoot, 'prompts/system/base.md'),
      propertiesDir: path.join(projectRoot, 'prompts/properties'),
      categoriesDir: path.join(projectRoot, 'prompts/system/categories'),
      guestMessage: 'What is the wifi password?',
      context: { listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d' },
    });
    assert.ok(composed.selectedFiles.includes('wifi.md'));
    assert.ok(!composed.selectedFiles.includes('conversation-judge.md'));
    assert.ok(!composed.selectedFiles.includes('reflection.md'));
    assert.ok(!composed.text.includes('# Conversation Judge (Anti-Repetition'));
    assert.ok(!composed.text.includes('# Reflection / Critique Pass'));
    assert.ok(composed.chars < 80000, `first pass still too large: ${composed.chars}`);
  });
});

describe('Grok adapter defaults', () => {
  it('defaults to grok-4.3 at 0.2', () => {
    const adapter = new GrokLLMAdapter({ apiKey: 'test' });
    assert.equal(adapter.model, DRAFT_MODEL);
    assert.equal(adapter.temperature, DRAFT_TEMPERATURE);
    assert.equal(adapter.fallbackModel, REVIEWER_MODEL);
  });
});
