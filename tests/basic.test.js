import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { EventRequestTool } from '../src/tools/event/EventRequestTool.js';
import { ThermostatTool } from '../src/tools/hvac/ThermostatTool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

const hasGrokKey = !!process.env.GROK_API_KEY;

describe('EventRequestTool (no LLM)', () => {
  it('detects get-together party asks', async () => {
    const tool = new EventRequestTool();
    const result = await tool.execute(
      "We're thinking of having a small get-together with some friends while we're there. Is that okay?"
    );
    assert.equal(result.detected, true);
    assert.ok(result.standardResponse.includes('not able to accommodate events or gatherings'));
  });

  it('forces canonical event decline via _applyEventRequestPolicy', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyEventRequestPolicy(
      { typeOfMessageReceived: 'EVENT_REQUEST', proposedResponse: 'Sorry, parties are not allowed here.' },
      {}
    );
    assert.equal(applied.applied, true);
    assert.ok(applied.proposedResponse.includes('not able to accommodate events or gatherings'));
  });

  it('forces thermostat neutral remote wording via _applyThermostatPolicy', async () => {
    const thermostatTool = new ThermostatTool();
    const thermo = await thermostatTool.execute("How do I turn up the heat? It's cold in here.", {
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      guestName: 'Casey'
    });
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyThermostatPolicy(
      { typeOfMessageReceived: 'THERMOSTAT_HEATPUMP', proposedResponse: 'Use the wall controls to adjust the temperature.' },
      { earlyThermostatInfo: thermo },
      "How do I turn up the heat? It's cold in here."
    );
    assert.equal(applied.applied, true);
    assert.ok(applied.proposedResponse.includes('make sure you are using'));
    assert.ok(applied.proposedResponse.includes('remotes on the wall'));
  });

  it('reclassifies pre-arrival sofa linens away from EXTRA_LINENS_TOWELS', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = "Hi Jerome and Ruby, we're looking forward to our stay. I just want to make sure there are sheets/blankets/pillows for our friend (our 4th) who will be sleeping on the couch. Please confirm. Thank you! -Amy";
    const applied = agent._applySofaBedLinensPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse: 'Good morning Amy, yes, we provide sheets, blankets, and pillows for the sofa bed. They are stored in the storage compartment under the sofa.'
      },
      { checkIn: '2026-07-18', guestName: 'Amy' },
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'SLEEPING_ARRANGEMENTS');
  });
});

describe('GuestMessagingAgent', { skip: !hasGrokKey }, () => {
  // These tests require a real GROK_API_KEY.
  // The mock LLM has been permanently removed (even for unit tests).

  it('handles the Michele inquiry scenario without mentioning pet fees', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests
    });

    const result = await agent.processMessage(
      "Hi Jerome\nI'm coming to Portland again today and leaving Saturday\nIs your place available ?",
      {
        guestName: 'Michele',
        checkIn: '2026-04-09',
        checkOut: '2026-04-10',
        listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
        hasPets: false
      }
    );

    assert.equal(result.shouldReply, true);
    assert.ok(result.proposedResponse.length > 20);
    assert.ok(!result.proposedResponse.toLowerCase().includes('$30'));
    assert.ok(!result.proposedResponse.toLowerCase().includes('pet fee'));
  });

  it('returns OTHER_MESSAGE + none for unclear input by default', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests
    });
    const result = await agent.processMessage('asdfghjkl random nonsense qwerty');
    assert.equal(result.typeOfMessageReceived, 'OTHER_MESSAGE');
    assert.equal(result.proposedResponse, 'none');
  });

  it('loads modular prompt with categories when useModularPrompt is true', async () => {
    const modularAgent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      useModularPrompt: true
    });

    const prompt = await modularAgent.loadPrompt({});
    assert.ok(prompt.includes('Category Rules'), 'Modular prompt should include category rules');
    assert.ok(prompt.includes('cancellation') || prompt.includes('Cancellation'), 'Should include cancellation category');
  });

  it('can load raw production prompt when fullPromptPath is provided', async () => {
    const rawPath = path.join(projectRootForTests, 'prompts/system/raw/production-system-prompt-raw.txt');
    const rawAgent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      fullPromptPath: rawPath
    });

    const prompt = await rawAgent.loadPrompt({});
    assert.ok(prompt.length > 1000, 'Raw prompt should be substantial');
  });

  it('supports reflection mode without crashing', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      enableReflection: true,
      reflectionCategories: ['CANCELLATION_POLICY']
    });

    // This should not throw even with real Grok responses
    const result = await agent.handleMessage(
      "I need to cancel my reservation due to an emergency.",
      {
        guestName: 'Test',
        bookingTimestamp: '2026-05-01T10:00:00Z',
        checkIn: '2026-06-01',
        listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d'
      }
    );

    assert.ok(result);
    // Either reflection ran or it was skipped gracefully
    assert.ok(result.reflection === undefined || typeof result.reflection.decision === 'string');
  });

  it('supports Conversation Judge mode without crashing', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      enableConversationJudge: true
    });

    const result = await agent.handleMessage(
      "Hi, I'm excited for the weekend!",
      {
        guestName: 'TestUser',
        listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d'
      }
    );

    assert.ok(result);
    assert.ok(
      result.conversationJudge === undefined ||
      ['APPROVE', 'REVISE', 'REJECT'].includes(result.conversationJudge.verdict)
    );
  });

  it('detects cleaning issues using the unified Tool (CleaningIssueTool) in handleMessage', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests
    });

    const result = await agent.handleMessage(
      "There was hair in the shower and the ceiling tiles were stained when we arrived.",
      {
        guestName: 'Josh',
        checkIn: '2026-05-25',
        checkOut: '2026-05-27',
        listingId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
        propertyName: '53 Pine #1B'
      }
    );

    assert.equal(result.cleaningIssueDetected, true);
    // When the agent doesn't know how to answer, it escalates
    assert.equal(result.escalated, true);
  });

  it('returns structured thermostat instructions via ThermostatTool for HVAC-related messages', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests
    });

    // Apt 3 has a known "ignore the Nest" warning
    const result = await agent.handleMessage(
      "How do I turn on the heat? It's freezing in here.",
      {
        guestName: 'Alex',
        listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
        propertyName: 'Apt 3'
      }
    );

    assert.ok(result.thermostatInfo);
    assert.equal(result.thermostatInfo.detected, true);
    assert.ok(result.thermostatInfo.warning && result.thermostatInfo.warning.includes("make sure you are using the heat pump remotes"));
    assert.ok(result.thermostatInfo.system.includes('KumoCloud'));
    assert.ok(result.thermostatInfo.howTo.some(step => step.includes('remotes on the wall')));
  });

  it('replies with a short warm acknowledgment to courteous FYI statements that require no information or action from host (real Grok call)', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests
    });

    // Real production case (Menghang/David, mid-stay courtesy note about a harmless cooking incident).
    // This used to be incorrectly treated as OTHER_MESSAGE + "none" → escalated with no auto-reply.
    // The fyi-statements.md category + base.md rule now explicitly requires a brief ack + shouldReply: true.
    const result = await agent.handleMessage(
      "Hi Jerome, I think our fried eggs triggers smoke detector broadcast. I want to inform you so no unnecessary fire truck visit.😆",
      {
        guestName: 'Menghang(David)',
        listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd', // Apt 3
        propertyName: 'Apt 3',
        // Minimal stay context — this is a mid-stay FYI, not a welcome or question
        checkIn: '2026-05-20',
        checkOut: '2026-05-23'
      }
    );

    // Core guarantee: we must auto-reply to these thoughtful non-actionable updates
    assert.equal(result.shouldReply, true, 'FYI courtesy statements must trigger shouldReply=true');
    assert.ok(
      result.proposedResponse && result.proposedResponse !== 'none' && result.proposedResponse.length > 15,
      'Must propose a real acknowledgment response, not empty/none'
    );
    assert.equal(result.escalated, false, 'Should not escalate FYI statements that we can politely acknowledge');
    // The response should feel like a warm, brief host ack (loose check for natural language)
    const lower = result.proposedResponse.toLowerCase();
    const hasAckTone = lower.includes('thanks') || lower.includes('thank') || lower.includes('appreciate') ||
                       lower.includes('glad') || lower.includes('no worries') || lower.includes('heads up') ||
                       lower.includes('good to know');
    assert.ok(hasAckTone, 'Response should contain warm acknowledgment language (thanks/appreciate/glad/no worries/etc.)');
  });

  it('replies with short warm "You are welcome" acknowledgment to post-checkout thank-you messages (real Grok call)', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests
    });

    // Real production case (Menghang/David on Apt 2, 5:34AM PDT checkout thank-you).
    // Previously dropped entirely by the handler host-filter bug (user.name="Jerome Ansia" always present).
    // Even if it reached the agent, THANK_YOU_MESSAGE + GUEST_CHECKOUT overlap needed clear rules.
    // Exact guest text that must now produce a brief warm "You're welcome, David!" style reply.
    const result = await agent.handleMessage(
      "Hi Jerome, we just checked out and started the dishwasher. Thanks again for your host!",
      {
        guestName: 'Menghang(David)',
        listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d', // Sunny Downtown 2 Bed Apt (Apt 2) from the actual CloudWatch payload
        propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
        checkIn: '2026-05-24',
        checkOut: '2026-05-31',
        // Simulate the webhook context.user (host account) + sender that previously triggered the bad filter
        user: { id: '436eb2ed-5174-5542-926f-5013bae34188', name: 'Jerome Ansia' },
        sender: { type: 'guest', full_name: 'Menghang(David)', first_name: 'Menghang(David)' },
        sender_type: 'guest',
        conversation_id: '3444a0a7-4888-44d3-81cd-5550a585d9c9',
        reservationId: 'e38f9e75-9f58-4e2e-afff-2a12457fc0c9'
      }
    );

    assert.equal(result.shouldReply, true, 'Checkout thank-you must trigger shouldReply=true (You are welcome category)');
    assert.ok(
      result.proposedResponse && result.proposedResponse !== 'none' && result.proposedResponse.length > 10,
      'Must propose a real "You are welcome" / acknowledgment response'
    );
    assert.equal(result.escalated, false, 'Must not escalate a simple courteous checkout thank-you');
    const lower = result.proposedResponse.toLowerCase();
    const hasWelcomeTone = lower.includes('welcome') || lower.includes('glad') || lower.includes('enjoyed') ||
                           lower.includes('safe') || lower.includes('travel') || lower.includes('thanks') ||
                           lower.includes('appreciate');
    assert.ok(hasWelcomeTone, 'Response should be a warm "You are welcome" / safe travels style ack');
    // Prefer natural short name "David" (the normalize fix + category rule)
    const usesNaturalName = result.proposedResponse.includes('David') || result.proposedResponse.includes(', D');
    // Not a hard assert (model may vary), but log for visibility
    if (!usesNaturalName) {
      console.log('[test] Note: proposedResponse did not obviously use short name "David":', result.proposedResponse);
    }
  });
});
