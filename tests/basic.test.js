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

  it('does not false-positive on checkout trash-gathering thank-you (Rene checkout incident)', async () => {
    const tool = new EventRequestTool();
    const msg = 'Good Morning Jerome! We have officially checked out. We pulled the linens, and gathered all of the trash in one area. I think we\'ve gotten everything out! Have a great day and thanks for letting us stay here.';
    const result = await tool.execute(msg);
    assert.equal(result.detected, false);
  });

  it('skips event policy on post-checkout thank-you messages', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Good Morning Jerome! We have officially checked out. We pulled the linens, and gathered all of the trash in one area. Thanks for letting us stay here.';
    const ctx = {
      guestName: 'Rene',
      checkIn: '2026-06-29',
      checkOut: '2026-07-02',
      asOfDate: '2026-07-02',
      earlyEventDetection: { detected: true, standardResponse: 'event decline' },
    };
    const applied = agent._applyEventRequestPolicy(
      { typeOfMessageReceived: 'EVENT_REQUEST', proposedResponse: 'event decline' },
      ctx,
      msg
    );
    assert.equal(applied.applied, false);
  });

  it('does not false-positive on Airbnb booking intros or hotel recommendations', async () => {
    const tool = new ThermostatTool();
    const abby = await tool.execute(
      'Hello! We are booking this Airbnb to celebrate my boyfriend and his twin\'s 30th birthday! We look forward to exploring Portland! Thanks!',
      { listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd' }
    );
    const hotel = await tool.execute(
      'Do you have any hotel recommendations in the area?',
      { listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d' }
    );
    assert.equal(abby.guestMessageRelevant, false);
    assert.equal(hotel.guestMessageRelevant, false);
  });

  it('does not apply thermostat policy to NEW_RESERVATION_WELCOME', async () => {
    const thermostatTool = new ThermostatTool();
    const thermo = await thermostatTool.execute(
      'Hello! We are booking this Airbnb to celebrate my boyfriend and his twin\'s 30th birthday!',
      { listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd', guestName: 'Abby' }
    );
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyThermostatPolicy(
      { typeOfMessageReceived: 'NEW_RESERVATION_WELCOME', proposedResponse: 'Good afternoon Abby, welcome! Check-in is at 4pm with self-check-in and parking.' },
      { earlyThermostatInfo: thermo },
      'Hello! We are booking this Airbnb...'
    );
    assert.equal(applied.applied, false);
  });

  it('forces Richard + phone via _applyLuggagePolicy when LLM omits contact (luggage-drop-off eval)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyLuggagePolicy(
      {
        typeOfMessageReceived: 'LUGGAGE_DROP_OFF',
        proposedResponse: 'Yes, early luggage drop-off is usually fine before check-in. Just let us know your timing.',
      },
      { guestName: 'Sam' },
      'Can we drop our luggage off early before check-in?'
    );
    assert.equal(applied.applied, true);
    assert.ok(applied.proposedResponse.includes('Richard'));
    assert.ok(applied.proposedResponse.includes('807-8071'));
  });

  it('directs payment method updates to Airbnb via _applyPaymentMethodPolicy (Julie AMEX incident)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = "Hello! I did need to update our payment method to an AMEX card as our prior cc had fraudulent charges and had to be cancelled. When it comes time to charging for the stay, please make sure to bill the AMEX and not the Visa originally used. Thank you!";
    const applied = agent._applyPaymentMethodPolicy(
      {
        typeOfMessageReceived: 'FYI_STATEMENT',
        proposedResponse: "Thank you for the update, Julie. I'll note that the AMEX should be used for the stay charges.",
      },
      { guestName: 'Julie' },
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'PAYMENT_METHOD_UPDATE');
    assert.ok(applied.proposedResponse.includes('Airbnb'));
    assert.ok(applied.proposedResponse.includes('do not handle payments'));
    assert.ok(!/i'll note|i will note/i.test(applied.proposedResponse));
  });

  it('confirms each remote controls one unit via _applyHvacRemotePerUnitPolicy', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Does the one remote work both air units?';
    const applied = agent._applyHvacRemotePerUnitPolicy(
      {
        typeOfMessageReceived: 'THERMOSTAT_HEATPUMP',
        proposedResponse: 'Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat does not control the AC or heat.',
      },
      { guestName: 'Alex' },
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'HVAC_REMOTE_PER_UNIT');
    assert.equal(applied.proposedResponse, 'Hi Alex, no. Each remote is for a single unit.');
    assert.ok(!/nest|make sure you are using/i.test(applied.proposedResponse));

    const bare = agent._applyHvacRemotePerUnitPolicy(
      { typeOfMessageReceived: 'THERMOSTAT_HEATPUMP', proposedResponse: 'Use the wall remotes.' },
      {},
      msg
    );
    assert.equal(bare.proposedResponse, 'No, each remote is for a single unit.');
  });

  it('confirms security deposit refund via Airbnb via _applySecurityDepositPolicy', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = "Hi Jerome! I had a question about the deposit. I noticed in the house rules it mentions something about a $250 deposit. Is that's something I will get back? I didn't even realize that there was a deposit (which is cool). But it stated if the house rules were broken that the deposit isn't refundable, but luckily I didn't have any house parties or break any rules!";
    const applied = agent._applySecurityDepositPolicy(
      {
        typeOfMessageReceived: 'FYI_STATEMENT',
        proposedResponse: "Thanks for letting me know you followed the house rules! Glad everything went well.",
      },
      { guestName: 'Alex' },
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'SECURITY_DEPOSIT_QUESTION');
    assert.ok(applied.proposedResponse.includes('get it back automatically'));
    assert.ok(applied.proposedResponse.includes('Airbnb'));
    assert.ok(applied.proposedResponse.includes('not done by us'));
    assert.ok(!/i'll refund|i will refund|we will refund/i.test(applied.proposedResponse));
  });

  it('answers laundry facilities with Soap Bubble via _applyLaundryPolicy (Henry bad-reply case)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    // Real guest wording: thanks + excitement + laundry ask. Old bad auto deferred instead of answering.
    const msg = 'Thanks so much! We are excited for our stay. Is there laundry?';
    const badDraft =
      "Good morning, Henry! You're welcome. I'll check on laundry for you and get back shortly.";
    const applied = agent._applyLaundryPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: badDraft,
      },
      { guestName: 'Henry' },
      msg
    );
    assert.equal(applied.applied, true);
    // Multi-categorization: thanks + laundry must both be present
    assert.deepEqual(applied.typeOfMessageReceived, ['THANK_YOU_MESSAGE', 'LAUNDRY_QUESTION']);
    // Combined final reply: You're welcome + Soap Bubble facts (not deferral)
    assert.ok(/you'?re welcome/i.test(applied.proposedResponse));
    assert.ok(/do not have laundry on site|no laundry on site/i.test(applied.proposedResponse));
    assert.ok(applied.proposedResponse.includes('Soap Bubble'));
    assert.ok(applied.proposedResponse.includes('68 Pine St'));
    assert.ok(applied.proposedResponse.includes('Portland, ME 04102'));
    assert.ok(!/i'll check|i will check|get back shortly/i.test(applied.proposedResponse));
    // Expected shape for multi-intent with first-contact greeting preserved from draft
    assert.match(
      applied.proposedResponse,
      /Good morning, Henry! You're welcome\.\s+We do not have laundry on site/i
    );

    // Laundry-only (no thanks) → single category, no "You're welcome"
    const laundryOnly = agent._applyLaundryPolicy(
      {
        typeOfMessageReceived: 'OTHER_MESSAGE',
        proposedResponse: 'none',
      },
      { guestName: 'Henry' },
      'Is there laundry on site?'
    );
    assert.equal(laundryOnly.applied, true);
    assert.equal(laundryOnly.typeOfMessageReceived, 'LAUNDRY_QUESTION');
    assert.ok(laundryOnly.proposedResponse.includes('Soap Bubble'));
    assert.ok(!/you'?re welcome/i.test(laundryOnly.proposedResponse));

    // Detergent questions must not be overwritten by the facilities answer.
    const detergent = agent._applyLaundryPolicy(
      {
        typeOfMessageReceived: 'LAUNDRY_DETERGENT_QUESTION',
        proposedResponse: 'For laundry, we use Kirkland Brand detergent from Costco, and for drying sheets we use Tide.',
      },
      { guestName: 'Henry' },
      'What detergent do you use for laundry?'
    );
    assert.equal(detergent.applied, false);
  });

  it('forces Apt 2 street-door lockout recovery (Henry bolted-door incident), not keypad-only', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const apt2 = {
      guestName: 'Henry',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
      guestPhone: '6468040123',
    };
    const lockedOutMsg =
      'We accidentally locked the door not knowing that the front door locked and are unable to get into the Airbnb.';
    // Bad historical reply: only restate the unit/outside code
    const badDraft =
      "Good evening, Henry,\n\nSorry you're locked out! The code for the outside door and unit is 8040. Give that a try and let me know right away if you still can't get in.";

    const applied = agent._applyApt2StreetDoorLockoutPolicy(
      { typeOfMessageReceived: 'DOOR_CODE_ISSUE', proposedResponse: badDraft },
      apt2,
      lockedOutMsg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'APT2_STREET_DOOR_LOCKOUT');
    assert.ok(applied.proposedResponse.includes('2630'));
    assert.ok(/lock box/i.test(applied.proposedResponse));
    assert.ok(applied.proposedResponse.includes('top'));
    assert.ok(applied.proposedResponse.includes('0123'));
    assert.ok(applied.proposedResponse.includes('646-204-3958'));
    assert.ok(applied.proposedResponse.includes('508-667-6477'));
    assert.ok(applied.proposedResponse.includes('207-518-3417'));
    assert.ok(!/code for the outside door and unit is 8040/i.test(applied.proposedResponse));

    // LLM category correct but omits pin digits when phone is known → still force full script
    const missingPin = agent._applyApt2StreetDoorLockoutPolicy(
      {
        typeOfMessageReceived: 'APT2_STREET_DOOR_LOCKOUT',
        proposedResponse:
          "Sorry you're locked out! Top lock box 2630. Put the key back. Call 646-204-3958, 508-667-6477, or 207-518-3417.",
      },
      apt2,
      lockedOutMsg
    );
    assert.equal(missingPin.applied, true);
    assert.ok(missingPin.proposedResponse.includes('0123'));

    // Follow-up clarification "We bolted the door from the inside"
    const bolted = agent._applyApt2StreetDoorLockoutPolicy(
      { typeOfMessageReceived: 'DOOR_CODE_ISSUE', proposedResponse: badDraft },
      {
        ...apt2,
        conversationHistory: [
          { sender_type: 'guest', body: lockedOutMsg },
          { sender_type: 'host', body: badDraft },
        ],
      },
      'We bolted the door from the inside'
    );
    assert.equal(bolted.applied, true);
    assert.equal(bolted.typeOfMessageReceived, 'APT2_STREET_DOOR_LOCKOUT');
    assert.ok(bolted.proposedResponse.includes('2630'));

    // Must not fire for Apt 3 lockbox problems
    const apt3 = agent._applyApt2StreetDoorLockoutPolicy(
      { typeOfMessageReceived: 'APT3_LOCKBOX_ISSUE', proposedResponse: 'sorry you are having trouble with the lock box' },
      {
        guestName: 'Morgan',
        listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
        propertyName: 'Apt 3',
      },
      "I'm having trouble opening the lockbox. The code isn't working."
    );
    assert.equal(apt3.applied, false);

    // Generic "code not working" on Apt 2 without bolt/lockout-from-inside → not this category
    const codeOnly = agent._applyApt2StreetDoorLockoutPolicy(
      { typeOfMessageReceived: 'DOOR_CODE_ISSUE', proposedResponse: 'Please try backup code 1028.' },
      apt2,
      'The door code is not working for the parking entrance.'
    );
    assert.equal(codeOnly.applied, false);

    // "Did I leave the door unlocked?" is DOOR_LOCKING_ISSUE territory — not street lockout
    const forgotLock = agent._applyApt2StreetDoorLockoutPolicy(
      { typeOfMessageReceived: 'DOOR_LOCKING_ISSUE', proposedResponse: 'The door automatically lock within 5 minutes.' },
      apt2,
      'I think I forgot to lock the door when I left. Is that a problem?'
    );
    assert.equal(forgotLock.applied, false);
  });

  it('merges multi-intent categories via _mergeCategories', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    assert.deepEqual(
      agent._mergeCategories('THANK_YOU_MESSAGE', 'LAUNDRY_QUESTION'),
      ['THANK_YOU_MESSAGE', 'LAUNDRY_QUESTION']
    );
    assert.deepEqual(
      agent._mergeCategories(['THANK_YOU_MESSAGE', 'LAUNDRY_QUESTION'], 'LAUNDRY_QUESTION'),
      ['THANK_YOU_MESSAGE', 'LAUNDRY_QUESTION']
    );
    assert.equal(agent._mergeCategories(null, 'LAUNDRY_QUESTION'), 'LAUNDRY_QUESTION');
    assert.equal(agent._hasThankYouIntent('Thanks so much! Is there laundry?'), true);
    assert.equal(agent._hasThankYouIntent('Is there laundry?'), false);
  });

  it('does not stomp luggage reply that already has Richard and phone', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyLuggagePolicy(
      {
        typeOfMessageReceived: 'LUGGAGE_DROP_OFF',
        proposedResponse: 'Please contact Richard at (207) 807-8071 to coordinate early drop-off.',
      },
      {},
      'Can we drop our luggage off early before check-in?'
    );
    assert.equal(applied.applied, false);
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

  it('detects pure first-post-booking intro (Cheryl case) despite history fetch failed', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = "Hello Ruby and Jerome,\n\nI am visiting with my young adult daughter and her friend. It will be my first time (not theirs) in Portland. I chose this place because we can walk to everything.\n\nThank you,\nCheryl";
    const ctx = {
      reservationId: '390bc10a-7b33-484e-b3a0-f23241e3c158',
      conversationTraces: { historyFetchFailed: true, historySource: 'live_fetch_failed', hasRecentHostMessage: false }
    };
    assert.equal(agent._isPureFirstPostBookingIntro(msg, ctx), true);
    assert.equal(agent._shouldApplyHistoryFetchConservativeMode(msg, ctx), false);
    assert.equal(agent._looksLikePlausibleFollowUp(msg), false);
  });

  it('forces shouldReply via _applyPureWelcomeReplyPolicy when welcome withheld', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = "Hello Ruby and Jerome,\n\nI am visiting with my young adult daughter and her friend. It will be my first time (not theirs) in Portland. I chose this place because we can walk to everything.\n\nThank you,\nCheryl";
    const ctx = {
      reservationId: '390bc10a-7b33-484e-b3a0-f23241e3c158',
      conversationTraces: { historyFetchFailed: true, historySource: 'live_fetch_failed', hasRecentHostMessage: false }
    };
    const applied = agent._applyPureWelcomeReplyPolicy(
      {
        typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
        proposedResponse: 'Hi Cheryl, welcome! Check-in is at 4pm with self-check-in and parking.',
        shouldReply: false,
        escalated: true
      },
      ctx,
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.escalated, false);
  });

  it('normalizes bare CANCELLATION to CANCELLATION_POLICY for refund questions', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Hi, we actually need to cancel right away. We just booked yesterday. What refund would we get?';
    const parsed = { typeOfMessageReceived: 'CANCELLATION', proposedResponse: 'none', shouldReply: false };
    const applied = agent._applyCancellationCategoryPolicy(parsed, msg);
    assert.equal(applied.applied, true);
    assert.equal(parsed.typeOfMessageReceived, 'CANCELLATION_POLICY');
  });

  it('rejects premature designated-spot confirmation before check-in (Amie incident)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Hi are we able to park in the designated spot before the check in time at 4?';
    const ctx = {
      guestName: 'Amie',
      checkIn: '2026-06-18',
      conversationTraces: { earlyUnitReadyOffered: false }
    };
    const parsed = {
      typeOfMessageReceived: 'PARKING',
      proposedResponse: "Good morning, Amie, yes the designated spot is available for you. If the cleaning team is still there when you arrive we'll message you as soon as it's free.",
      shouldReply: true
    };
    const applied = agent._applyPreCheckInParkingPolicy(parsed, ctx, msg);
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /4pm/i);
    assert.match(applied.proposedResponse, /cleaning team/i);
    assert.match(applied.proposedResponse, /message you/i);
    assert.doesNotMatch(applied.proposedResponse, /spot is available/i);
  });

  it('does not apply pre-check-in parking policy when host already offered unit ready', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Hi are we able to park in the designated spot before the check in time at 4?';
    const ctx = {
      guestName: 'Amie',
      conversationTraces: { earlyUnitReadyOffered: true }
    };
    const applied = agent._applyPreCheckInParkingPolicy(
      { typeOfMessageReceived: 'PARKING', proposedResponse: 'Yes, you can use the spot now.' },
      ctx,
      msg
    );
    assert.equal(applied.applied, false);
  });

  it('resolves conversation_id for messages API instead of reservationId (Rene 404 bug)', async () => {
    const { ConversationContextTool } = await import('../src/tools/conversation/ConversationContextTool.js');
    const tool = new ConversationContextTool({ hospitableClient: null });
    const { conversationId, reservationId } = await tool.resolveConversationIdForMessages({
      reservationId: '17e9d5b0-3493-4dc0-b218-0c81677551c1',
      conversation_id: 'f3495ee2-2c2a-46e8-b8cd-49d661bee627'
    });
    assert.equal(conversationId, 'f3495ee2-2c2a-46e8-b8cd-49d661bee627');
    assert.equal(reservationId, '17e9d5b0-3493-4dc0-b218-0c81677551c1');
    assert.notEqual(conversationId, reservationId);
  });

  it('deterministic judge guard REVISEs duplicate welcome on post-welcome thanks', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Thank you so much! I appreciate your prompt response! We are super excited!';
    const ctx = {
      guestName: 'Rene',
      conversationHistory: [
        { sender_type: 'host', body: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and parking.' }
      ],
      conversationTraces: { recentWelcomeSent: true, hasRecentHostMessage: true }
    };
    const decision = {
      typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
      proposedResponse: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and the $30 pet fee is already included.',
      shouldReply: true
    };
    const guarded = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', notes: 'LLM missed it' },
      decision,
      ctx,
      msg
    );
    assert.equal(guarded.verdict, 'REVISE');
    assert.equal(guarded.deterministicGuard, true);
    assert.match(guarded.revisedResponse, /you're welcome, rene/i);
    assert.doesNotMatch(guarded.revisedResponse, /4pm|pet fee/i);
  });

  it('judge prompt uses enriched conversationHistory not empty webhook history', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const prompt = await agent._buildConversationJudgePrompt(
      { typeOfMessageReceived: 'THANK_YOU_MESSAGE', proposedResponse: "You're welcome, Rene!", shouldReply: true },
      { conversationContext: { recentWelcomeSent: true, lastHostMessagePreview: 'Check-in is at 4pm with self-check-in' } },
      {
        originalMessage: 'Thank you so much!',
        conversationHistory: [
          { sender_type: 'host', body: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and parking.' }
        ]
      }
    );
    assert.match(prompt, /RECENT CONVERSATION HISTORY/);
    assert.match(prompt, /Check-in is at 4pm with self-check-in and parking/);
    assert.match(prompt, /POST-WELCOME THANK-YOU/);
  });

  it('strips safe travels from in-stay temporary departure thank-you (Amie blanket incident)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Thank you we just left the apartment!';
    const ctx = {
      guestName: 'Amie',
      checkIn: '2026-06-19',
      checkOut: '2026-06-21',
      asOfDate: '2026-06-19',
      listingId: 'c899481f-2e5b-402d-80c4-3167fd824d96'
    };
    const parsed = {
      typeOfMessageReceived: 'THANK_YOU_MESSAGE',
      proposedResponse: "You're welcome, Amie! Safe travels.",
      shouldReply: true
    };
    const applied = agent._applyInStayDepartureThankYouPolicy(parsed, ctx, msg);
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'THANK_YOU_MESSAGE');
    assert.match(applied.proposedResponse, /you're welcome, amie/i);
    assert.doesNotMatch(applied.proposedResponse, /safe travels/i);
  });

  it('deterministic judge guard removes safe travels on in-stay step-out thanks', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Thank you we just left the apartment!';
    const ctx = {
      guestName: 'Amie',
      checkIn: '2026-06-19',
      checkOut: '2026-06-21',
      asOfDate: '2026-06-19'
    };
    const decision = {
      typeOfMessageReceived: 'THANK_YOU_MESSAGE',
      proposedResponse: "You're welcome, Amie! Safe travels.",
      shouldReply: true
    };
    const guarded = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', notes: 'LLM missed it' },
      decision,
      ctx,
      msg
    );
    assert.equal(guarded.verdict, 'REVISE');
    assert.equal(guarded.deterministicGuard, true);
    assert.match(guarded.revisedResponse, /you're welcome, amie/i);
    assert.doesNotMatch(guarded.revisedResponse, /safe travels/i);
  });

  it('still allows safe travels on actual checkout-day thank-you', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Hi Jerome, we just checked out and started the dishwasher. Thanks again for your host!';
    const ctx = {
      guestName: 'David',
      checkIn: '2026-05-24',
      checkOut: '2026-05-31',
      asOfDate: '2026-05-31'
    };
    assert.equal(agent._isTemporaryDepartureDuringStay(msg, ctx), false);
    const applied = agent._applyInStayDepartureThankYouPolicy(
      { typeOfMessageReceived: 'THANK_YOU_MESSAGE', proposedResponse: "You're welcome, David! Safe travels." },
      ctx,
      msg
    );
    assert.equal(applied.applied, false);
  });

  it('replaces duplicate welcome logistics with short thank-you ack (Rene incident)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Thank you so much! I appreciate your prompt response! We are super excited!';
    const ctx = {
      guestName: 'Rene',
      conversationHistory: [
        {
          sender_type: 'host',
          body: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and you have one dedicated off-street parking spot. The $30 pet fee is already included.'
        }
      ],
      conversationTraces: { recentWelcomeSent: true, hasRecentHostMessage: true }
    };
    const parsed = {
      typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
      proposedResponse: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and the $30 pet fee is already included.',
      shouldReply: true
    };
    const applied = agent._applyPostWelcomeThankYouPolicy(parsed, ctx, msg);
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'THANK_YOU_MESSAGE');
    assert.match(applied.proposedResponse, /you're welcome, rene/i);
    assert.doesNotMatch(applied.proposedResponse, /4pm|self-check-in|pet fee/i);
  });

  it('still uses history-fetch conservative mode for Taylor-style follow-ups', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = "Ahh that's perfect!! We will be arriving in about an hour! Thank you";
    const ctx = {
      reservationId: '390bc10a-7b33-484e-b3a0-f23241e3c158',
      conversationTraces: { historyFetchFailed: true, historySource: 'live_fetch_failed', hasRecentHostMessage: false }
    };
    assert.equal(agent._looksLikePlausibleFollowUp(msg), true);
    assert.equal(agent._shouldApplyHistoryFetchConservativeMode(msg, ctx), true);
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

  it('appends follow-up to in-stay extra towels replies (Sean incident)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Hi, are there more clean towels in the unit? I think each bedroom has one.';
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse: 'Good evening, Sean, yes there are extra clean towels under the sofa bed. Lift up the long part of the sofa to reveal them along with the linens.'
      },
      { guestName: 'Sean' },
      msg
    );
    assert.equal(applied.applied, true);
    assert.ok(applied.proposedResponse.includes('feel free to let us know'));
    assert.ok(applied.proposedResponse.includes('Lift up the long part of the sofa'));
  });

  it('does not double-append follow-up when EXTRA_LINENS_TOWELS reply already offers help', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Hi, are there more clean towels in the unit?';
    const applied = agent._applyExtraLinensTowelsPolicy(
      {
        typeOfMessageReceived: 'EXTRA_LINENS_TOWELS',
        proposedResponse: 'Yes, lift up the long part of the sofa to reveal extra towels and linens. Let me know if you can find them!'
      },
      {},
      msg
    );
    assert.equal(applied.applied, false);
  });
});

function mockHospitableClient({ getReservationMessages, getConversationMessages, getInquiryMessages } = {}) {
  const inquiryFetcher = getInquiryMessages || getConversationMessages;
  return {
    async getReservationMessages(...args) {
      return getReservationMessages(...args);
    },
    async getConversationMessages(...args) {
      return getConversationMessages(...args);
    },
    async getInquiryMessages(...args) {
      return inquiryFetcher(...args);
    },
    async getThreadMessages({ reservationId, conversationId, isInquiry } = {}, limit) {
      if (reservationId) return getReservationMessages(reservationId, limit);
      if (conversationId) {
        if (isInquiry !== false) return inquiryFetcher(conversationId, limit);
        return getConversationMessages(conversationId, limit);
      }
      throw new Error('reservationId or conversationId is required for getThreadMessages');
    },
  };
}

describe('Post-checkout thank-you safeguards (no LLM)', () => {
  const reneCheckoutMsg = 'Good Morning Jerome! We have officially checked out. We pulled the linens, and gathered all of the trash in one area. I think we\'ve gotten everything out! Have a great day and thanks for letting us stay here.';
  const reneCtx = {
    guestName: 'Rene',
    checkIn: '2026-06-29',
    checkOut: '2026-07-02',
    asOfDate: '2026-07-02',
  };

  it('detects post-checkout thank-you messages', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    assert.equal(agent._isPostCheckoutThankYou(reneCheckoutMsg, reneCtx), true);
  });

  it('replaces EVENT_REQUEST decline with warm checkout thank-you ack', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const parsed = {
      typeOfMessageReceived: 'EVENT_REQUEST',
      proposedResponse: "Thank you for thinking of our place for your event! Unfortunately, we're not able to accommodate events or gatherings.",
      rawModelOutput: JSON.stringify({
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Rene! Safe travels and hope you enjoyed your stay.",
      }),
    };
    const applied = agent._applyPostCheckoutThankYouPolicy(parsed, reneCtx, reneCheckoutMsg);
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'THANK_YOU_MESSAGE');
    assert.match(applied.proposedResponse, /you're welcome, rene/i);
    assert.doesNotMatch(applied.proposedResponse, /events or gatherings/i);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.escalated, false);
  });

  it('does not treat stay-extension checkout-date asks as post-checkout thank-you (Lilly incident)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = "Hello, I'm wondering if I could extend our stay by one day -- instead of checking out on 28th, we'd check out on the 29th. Let me know, thanks!";
    const ctx = {
      guestName: 'Lilly',
      checkIn: '2026-09-26',
      checkOut: '2026-09-29',
      stayExtensionInfo: { detected: true, extensionType: 'later_checkout' },
    };
    assert.equal(agent._looksLikeStayExtensionRequest(msg, ctx), true);
    assert.equal(agent._isPostCheckoutThankYou(msg, ctx), false);
    const applied = agent._applyPostCheckoutThankYouPolicy(
      { typeOfMessageReceived: 'STAY_EXTENSION', proposedResponse: 'I checked the calendar for 53 Pine St #3 and the 29th is not available.' },
      ctx,
      msg
    );
    assert.equal(applied.applied, false);
  });

  it('deterministic judge guard REVISEs judge REJECT on misclassified checkout thank-you', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const decision = {
      typeOfMessageReceived: 'EVENT_REQUEST',
      proposedResponse: "Thank you for thinking of our place for your event! Unfortunately, we're not able to accommodate events or gatherings.",
      shouldReply: true,
      rawModelOutput: JSON.stringify({
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Rene! Safe travels and hope you enjoyed your stay.",
      }),
    };
    const guarded = agent._applyDeterministicJudgeGuards(
      {
        verdict: 'REJECT',
        notes: 'Draft mismatched to guest checkout message.',
        issues: ['EVENT_REQUEST language on checkout thank-you'],
      },
      decision,
      reneCtx,
      reneCheckoutMsg
    );
    assert.equal(guarded.verdict, 'REVISE');
    assert.equal(guarded.deterministicGuard, true);
    assert.match(guarded.revisedResponse, /you're welcome, rene/i);
    assert.doesNotMatch(guarded.revisedResponse, /events or gatherings/i);
  });
});

describe('THANK_YOU_MESSAGE repeat allowance (no LLM)', () => {
  it('allows repeat replies when host recently sent a short welcome ack', async () => {
    const { ConversationContextTool } = await import('../src/tools/conversation/ConversationContextTool.js');
    const tool = new ConversationContextTool({
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => [
          { sender_type: 'host', body: "You're welcome, Olivia!", created_at: new Date().toISOString() },
        ],
      }),
    });

    const result = await tool.execute('Thanks again for the quick response!', {
      conversation_id: 'conv-repeat-thanks',
      reservationId: 'res-repeat-thanks',
      requireLiveConversationHistory: true,
    });

    assert.equal(result.duplicateRisk, false);
    assert.equal(result.hasRecentHostMessage, true);
  });

  it('does not suppress THANK_YOU_MESSAGE due to recent host activity', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () => JSON.stringify({
          typeOfMessageReceived: 'THANK_YOU_MESSAGE',
          proposedResponse: "You're welcome, Olivia!",
          shouldReply: true,
          confidence: 0.95,
        }),
      },
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => [
          { sender_type: 'host', body: "You're welcome, Olivia!", created_at: new Date().toISOString() },
        ],
      }),
      requireLiveConversationHistory: false,
    });

    const result = await agent.handleMessage('Thanks again!', {
      guestName: 'Olivia',
      conversation_id: 'conv-repeat-thanks-2',
      reservationId: 'res-repeat-thanks-2',
      sender_type: 'guest',
    });

    assert.equal(result.typeOfMessageReceived, 'THANK_YOU_MESSAGE');
    assert.equal(result.shouldReply, true);
    assert.match(result.proposedResponse, /you're welcome, olivia/i);
  });
});

describe('Judge rewrite quality loop (no real LLM)', () => {
  it('builds rewrite prompt with critique + tool ground truth', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const prompt = agent._buildJudgeRewritePrompt(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "Good morning, Olivia, You're welcome!",
      },
      {
        verdict: 'REVISE',
        issues: ['Repeated recent host greeting'],
        rewriteBrief: 'Strip Good morning; keep short You\'re welcome only',
        notes: 'greeting repeat',
      },
      { conversationContext: { recentHostGreeting: true } },
      { originalMessage: 'Thanks for the quick response!' }
    );
    assert.match(prompt, /REWRITE TASK/);
    assert.match(prompt, /Repeated recent host greeting/);
    assert.match(prompt, /Strip Good morning/);
    assert.match(prompt, /TOOL RESULTS/);
    assert.match(prompt, /Thanks for the quick response/);
  });

  it('rewriteFromJudgeCritique returns improved proposedResponse', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () => JSON.stringify({
          typeOfMessageReceived: 'THANK_YOU_MESSAGE',
          proposedResponse: "You're welcome, Olivia!",
          shouldReply: true,
        }),
      },
    });
    const rewritten = await agent.rewriteFromJudgeCritique(
      { typeOfMessageReceived: 'THANK_YOU_MESSAGE', proposedResponse: 'Good morning, Olivia, You\'re welcome!' },
      { verdict: 'REVISE', issues: ['Repeated recent host greeting'], rewriteBrief: 'Strip greeting' },
      {},
      { originalMessage: 'Thanks!' }
    );
    assert.ok(rewritten);
    assert.equal(rewritten.proposedResponse, "You're welcome, Olivia!");
  });

  it('runs critique → llm rewrite → verify and sends rewritten text', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      enableConversationJudge: true,
      enableJudgeRewriteLoop: true,
      requireLiveConversationHistory: false,
      llmAdapter: {
        complete: async (system) => {
          const s = String(system || '');
          if (s.includes('VERIFY pass')) {
            return JSON.stringify({
              verdict: 'APPROVE',
              issues: [],
              notes: 'rewrite fixed greeting',
              confidence: 1,
            });
          }
          if (s.includes('conversation quality reviewer')) {
            return JSON.stringify({
              verdict: 'REVISE',
              issues: ['Repeated recent host greeting'],
              rewriteBrief: "Strip Good morning greeting; use only You're welcome, Olivia!",
              notes: 'greeting repeat',
              confidence: 0.9,
            });
          }
          if (s.includes('rewriting')) {
            return JSON.stringify({
              typeOfMessageReceived: 'THANK_YOU_MESSAGE',
              proposedResponse: "You're welcome, Olivia!",
              shouldReply: true,
            });
          }
          return JSON.stringify({
            typeOfMessageReceived: 'THANK_YOU_MESSAGE',
            proposedResponse: "Good morning, Olivia, You're welcome!",
            shouldReply: true,
            confidence: 1,
          });
        },
      },
    });

    const result = await agent.handleMessage('Thanks for the quick response!', {
      guestName: 'Olivia',
      conversationHistory: [],
    });

    assert.equal(result.judgeRewrite?.source, 'llm_rewrite');
    assert.match(result.proposedResponse, /you're welcome, olivia/i);
    assert.ok(!/good morning/i.test(result.proposedResponse));
    assert.equal(result.conversationJudge?.verdict, 'APPROVE');
    assert.equal(result.conversationJudgeCritique?.verdict, 'REVISE');
    assert.equal(result.judgePasses?.length, 2);
    assert.equal(result.judgePasses[0].pass, 'critique');
    assert.equal(result.judgePasses[1].pass, 'verify');
    assert.equal(result.shouldReply, true);
  });

  it('falls back to judge revisedResponse when rewrite loop is disabled', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      enableConversationJudge: true,
      enableJudgeRewriteLoop: false,
      requireLiveConversationHistory: false,
      llmAdapter: {
        complete: async (system) => {
          const s = String(system || '');
          if (s.includes('conversation quality reviewer')) {
            return JSON.stringify({
              verdict: 'REVISE',
              issues: ['Repetitive greeting'],
              revisedResponse: "You're welcome, Sam!",
              notes: 'fixed',
            });
          }
          if (s.includes('rewriting')) {
            throw new Error('rewrite should not run when loop disabled');
          }
          return JSON.stringify({
            typeOfMessageReceived: 'THANK_YOU_MESSAGE',
            proposedResponse: 'Good morning, Sam, You are welcome and looking forward!',
            shouldReply: true,
            confidence: 1,
          });
        },
      },
    });

    const result = await agent.handleMessage('Thanks!', {
      guestName: 'Sam',
      conversationHistory: [],
    });

    assert.equal(result.judgeRewrite?.source, 'judge_revisedResponse');
    assert.equal(result.proposedResponse, "You're welcome, Sam!");
    assert.equal(result.judgePasses?.length, 1);
    assert.ok(!result.conversationJudgeVerify);
  });

  it('prefers deterministic_guard revisedResponse over llm rewrite when guard fires', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async (system) => {
          if (String(system || '').includes('rewriting')) {
            throw new Error('llm rewrite should not run when deterministic_guard supplies text');
          }
          return '{}';
        },
      },
    });

    const msg = 'Thank you so much! I appreciate your prompt response! We are super excited!';
    const badDecision = {
      typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
      proposedResponse: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and parking and the pet fee.',
      shouldReply: true,
    };
    const ctx = {
      guestName: 'Rene',
      originalMessage: msg,
      conversationHistory: [
        { sender_type: 'host', body: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and parking.' },
      ],
      conversationTraces: { recentWelcomeSent: true, hasRecentHostMessage: true },
    };

    const guarded = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', notes: 'LLM missed it' },
      badDecision,
      ctx,
      msg
    );
    assert.equal(guarded.verdict, 'REVISE');
    assert.equal(guarded.deterministicGuard, true);
    assert.match(guarded.revisedResponse, /you're welcome, rene/i);

    // Same selection rules as handleMessage quality loop (no second LLM rewrite).
    let candidateText = null;
    let rewriteMeta = null;
    if (guarded.deterministicGuard && guarded.revisedResponse) {
      candidateText = guarded.revisedResponse;
      rewriteMeta = { source: 'deterministic_guard', proposedResponse: candidateText };
    }
    assert.equal(rewriteMeta.source, 'deterministic_guard');
    assert.equal(candidateText, guarded.revisedResponse);
  });

  it('post-welcome thank-you still strips logistics with rewrite loop enabled', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      enableConversationJudge: true,
      enableJudgeRewriteLoop: true,
      requireLiveConversationHistory: false,
      llmAdapter: {
        complete: async (system) => {
          const s = String(system || '');
          if (s.includes('VERIFY pass') || s.includes('conversation quality reviewer')) {
            return JSON.stringify({ verdict: 'APPROVE', issues: [], notes: 'ok', confidence: 1 });
          }
          return JSON.stringify({
            typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
            proposedResponse: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and parking and the pet fee.',
            shouldReply: true,
            confidence: 1,
          });
        },
      },
    });

    const result = await agent.handleMessage(
      'Thank you so much! I appreciate your prompt response! We are super excited!',
      {
        guestName: 'Rene',
        conversationHistory: [
          { sender_type: 'host', body: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and parking.' },
        ],
        conversationTraces: { recentWelcomeSent: true, hasRecentHostMessage: true },
      }
    );

    assert.match(result.proposedResponse, /you're welcome, rene/i);
    assert.ok(!/4\s*pm|self-check-in|pet fee/i.test(result.proposedResponse));
    assert.equal(result.shouldReply, true);
  });
});

describe('Conversation history hard-fail (no LLM)', () => {
  it('throws ConversationHistoryRequiredError when live fetch fails and history is required', async () => {
    const { ConversationContextTool } = await import('../src/tools/conversation/ConversationContextTool.js');
    const tool = new ConversationContextTool({
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => {
          throw new Error('503 Service Unavailable');
        },
        getConversationMessages: async () => {
          throw new Error('404 Not Found');
        },
      }),
    });

    await assert.rejects(
      () => tool.execute('Thank you!', {
        conversation_id: 'f3495ee2-2c2a-46e8-b8cd-49d661bee627',
        reservationId: '17e9d5b0-3493-4dc0-b218-0c81677551c1',
        requireLiveConversationHistory: true,
      }),
      (err) => err.name === 'ConversationHistoryRequiredError'
    );
  });

  it('fetches inquiry thread via getInquiryMessages when no reservationId (not conversation endpoint)', async () => {
    const { ConversationContextTool } = await import('../src/tools/conversation/ConversationContextTool.js');
    let usedInquiryEndpoint = false;
    const tool = new ConversationContextTool({
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => {
          throw new Error('should not call reservation endpoint for inquiries');
        },
        getInquiryMessages: async (inquiryId) => {
          usedInquiryEndpoint = true;
          assert.equal(inquiryId, '9b00a88f-03ca-4aa8-b6cc-2c3475f35184');
          return [
            { sender_type: 'guest', body: 'Hello are you able to accommodate this reservation thanks', created_at: new Date().toISOString() },
          ];
        },
        getConversationMessages: async () => {
          throw new Error('should not call conversation endpoint for inquiries');
        },
      }),
    });

    const result = await tool.execute('Hello are you able to accommodate this reservation thanks', {
      conversation_id: '9b00a88f-03ca-4aa8-b6cc-2c3475f35184',
      requireLiveConversationHistory: true,
    });

    assert.equal(usedInquiryEndpoint, true);
    assert.equal(result.historySource, 'live_fetched');
    assert.equal(result.recentMessageCount, 1);
  });

  it('fetches reservation thread via getReservationMessages when reservationId is present (not conversation endpoint)', async () => {
    const { ConversationContextTool } = await import('../src/tools/conversation/ConversationContextTool.js');
    let usedReservationEndpoint = false;
    const tool = new ConversationContextTool({
      hospitableClient: mockHospitableClient({
        getReservationMessages: async (reservationId) => {
          usedReservationEndpoint = true;
          assert.equal(reservationId, '17e9d5b0-3493-4dc0-b218-0c81677551c1');
          return [
            { sender_type: 'host', body: 'Good afternoon, Rene, Check-in is at 4pm with self-check-in and parking.', created_at: new Date().toISOString() },
          ];
        },
        getConversationMessages: async () => {
          throw new Error('should not call conversation endpoint for reservations');
        },
      }),
    });

    const result = await tool.execute('Thank you!', {
      conversation_id: 'f3495ee2-2c2a-46e8-b8cd-49d661bee627',
      reservationId: '17e9d5b0-3493-4dc0-b218-0c81677551c1',
      requireLiveConversationHistory: true,
    });

    assert.equal(usedReservationEndpoint, true);
    assert.equal(result.historySource, 'live_fetched');
    assert.equal(result.recentWelcomeSent, true);
  });

  it('throws ConversationHistoryRequiredError when neither reservationId nor conversation_id is available', async () => {
    const { ConversationContextTool } = await import('../src/tools/conversation/ConversationContextTool.js');
    const tool = new ConversationContextTool({
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => [],
        getConversationMessages: async () => [],
      }),
    });

    await assert.rejects(
      () => tool.execute('Hello!', {
        requireLiveConversationHistory: true,
      }),
      (err) => err.name === 'ConversationHistoryRequiredError'
    );
  });

  it('falls back when live fetch fails but history is not required (eval mode)', async () => {
    const { ConversationContextTool } = await import('../src/tools/conversation/ConversationContextTool.js');
    const tool = new ConversationContextTool({
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => {
          throw new Error('should not call reservation endpoint without reservationId');
        },
        getConversationMessages: async () => {
          throw new Error('404 Not Found');
        },
      }),
    });

    const result = await tool.execute('Thank you!', {
      conversation_id: 'f3495ee2-2c2a-46e8-b8cd-49d661bee627',
      requireLiveConversationHistory: false,
    });
    assert.equal(result.historyFetchFailed, true);
    assert.equal(result.historySource, 'live_fetch_failed');
  });

  it('handleMessage hard-fails when hospitableClient cannot fetch history', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => {
          throw new Error('503 Service Unavailable');
        },
        getConversationMessages: async () => {
          throw new Error('404 Not Found');
        },
      }),
      requireLiveConversationHistory: true,
    });

    await assert.rejects(
      () => agent.handleMessage('Thank you so much!', {
        guestName: 'Rene',
        conversation_id: 'f3495ee2-2c2a-46e8-b8cd-49d661bee627',
        reservationId: '17e9d5b0-3493-4dc0-b218-0c81677551c1',
        sender_type: 'guest',
      }),
      (err) => err.name === 'ConversationHistoryRequiredError'
    );
  });
});

describe('Post-stay housekeeping feedback (no LLM)', () => {
  it('detects missing sofa bed sheets as a cleaning issue (Amy incident)', async () => {
    const { CleaningIssueTool } = await import('../src/tools/CleaningIssueTool.js');
    const tool = new CleaningIssueTool();
    const msg = 'We had a lovely stay. Happy to give 5 starts. The only thing was that there were no sheets for the sofa bed. Just an fyi for the next folks. Thanks for your hospitality! Best, amy';
    const result = await tool.execute(msg, {
      guestName: 'Amy',
      reservationId: '46285156-89b5-4db9-9b93-3b84f9ee05e1',
      propertyName: 'Cozy, Central 2 Bd Apt, Parking',
    });
    assert.equal(result.detected, true);
    assert.equal(result.matchedPhrase, 'no sheets');
  });

  it('auto-replies to post-stay housekeeping feedback with warm ack (Amy incident)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const msg = 'We had a lovely stay. Happy to give 5 starts. The only thing was that there were no sheets for the sofa bed. Just an fyi for the next folks. Thanks for your hospitality! Best, amy';
    assert.equal(agent._isPostStayHousekeepingFeedback(msg), true);
    assert.equal(agent._isPostWelcomeThankYouFollowUp(msg, { conversationTraces: { recentWelcomeSent: true } }), false);

    const applied = agent._applyPostStayHousekeepingFeedbackPolicy(
      { typeOfMessageReceived: 'SLEEPING_ARRANGEMENTS', proposedResponse: "You're welcome, Amy!" },
      { guestName: 'Amy' },
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.escalated, false);
    assert.equal(applied.typeOfMessageReceived, 'REVIEW_SUBMITTED');
    assert.ok(applied.proposedResponse.includes('heads up about the sofa bed'));
    assert.ok(applied.proposedResponse.includes('Safe travels'));
  });

  it('skips cleaning-issue escalation for post-stay housekeeping FYI but still escalates in-stay complaints', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const amyMsg = 'We had a lovely stay. The only thing was that there were no sheets for the sofa bed. Thanks!';
    const skipped = agent._applyCleaningIssueEscalationPolicy(
      { typeOfMessageReceived: 'SLEEPING_ARRANGEMENTS', proposedResponse: "You're welcome, Amy!" },
      { detected: true, matchedPhrase: 'no sheets' },
      amyMsg
    );
    assert.equal(skipped.applied, false);

    const escalated = agent._applyCleaningIssueEscalationPolicy(
      { typeOfMessageReceived: 'OTHER_MESSAGE', proposedResponse: 'Sorry about that.' },
      { detected: true, matchedPhrase: 'hair in the shower' },
      'There was hair in the shower when we arrived.'
    );
    assert.equal(escalated.applied, true);
    assert.equal(escalated.shouldReply, false);
    assert.equal(escalated.proposedResponse, 'none');
    assert.equal(escalated.escalated, true);
  });

  it('applies post-stay housekeeping policy in processMessage (eval runner path)', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () => JSON.stringify({
          typeOfMessageReceived: 'SLEEPING_ARRANGEMENTS',
          proposedResponse: "You're welcome, Amy!",
          shouldReply: true,
          confidence: 0.9,
        }),
      },
    });
    const msg = 'We had a lovely stay. Happy to give 5 starts. The only thing was that there were no sheets for the sofa bed. Just an fyi for the next folks. Thanks for your hospitality! Best, amy';
    const result = await agent.processMessage(msg, {
      guestName: 'Amy',
      checkIn: '2026-06-18',
      checkOut: '2026-06-19',
      asOfDate: '2026-06-19',
      listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
    });
    assert.equal(result.typeOfMessageReceived, 'REVIEW_SUBMITTED');
    assert.equal(result.shouldReply, true);
    assert.ok(result.proposedResponse.includes('heads up about the sofa bed'));
    assert.ok(result.proposedResponse.includes('Safe travels'));
    assert.ok(!result.proposedResponse.includes('storage compartment'));
  });

  it('does not treat post-stay housekeeping feedback as pre-arrival sofa linens ask', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const msg = 'We had a lovely stay. The only thing was that there were no sheets for the sofa bed. Thanks!';
    assert.equal(agent._isPreArrivalSofaLinensAsk(msg, { checkIn: '2026-06-18', checkOut: '2026-06-19' }), false);
  });

  it('does not treat post-stay housekeeping feedback as post-welcome thank-you in ConversationContextTool', async () => {
    const { ConversationContextTool } = await import('../src/tools/conversation/ConversationContextTool.js');
    const tool = new ConversationContextTool({
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => [
          { sender_type: 'host', body: 'Good morning Amy, check-in is at 4pm with self-check-in and parking.', created_at: new Date().toISOString() },
        ],
      }),
    });

    const msg = 'We had a lovely stay. The only thing was that there were no sheets for the sofa bed. Thanks for your hospitality!';
    const result = await tool.execute(msg, {
      conversation_id: 'ee09cc34-496b-4192-b12d-d0aa0f95c900',
      reservationId: '46285156-89b5-4db9-9b93-3b84f9ee05e1',
      requireLiveConversationHistory: true,
    });

    assert.equal(result.recentWelcomeSent, undefined);
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
