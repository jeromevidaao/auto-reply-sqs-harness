import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { setHostContactsForTests, TEST_HOST_CONTACTS, clearHostContactsCache } from '../src/config/hostContacts.js';
import { EventRequestTool } from '../src/tools/event/EventRequestTool.js';
import {
  additionalParkingDraft,
  isAdditionalParkingAsk,
  isEventHostingDenial,
  isTripPurposeEventMention,
} from '../src/tools/parking/additionalParking.js';
import {
  PET_OVER_MAX_SNIPPET,
  isPetOverMaxAsk,
  isUnlikelyEventIdiom,
} from '../src/tools/pets/petOverMax.js';
import { ThermostatTool } from '../src/tools/hvac/ThermostatTool.js';
import { StayExtensionTool } from '../src/tools/stay-extension/StayExtensionTool.js';
import { PostCheckoutParkingTool } from '../src/tools/parking/PostCheckoutParkingTool.js';
import {
  getTimeBasedGreeting,
  resolveNowForGreeting,
  stripLeadingFormalTimeGreeting,
  alignLeadingTimeGreeting,
} from '../src/utils/timeGreeting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

const hasGrokKey = !!process.env.GROK_API_KEY;

setHostContactsForTests(TEST_HOST_CONTACTS);
process.env.ALLOW_HOST_CONTACT_TEST_DEFAULTS = '1';

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

  const johnSecondCarMsg =
    "Hi Jerome & Ruby.\n\nWe are excited for our visit to Portland and the celebration of our niece's wedding. Thank you for the directions and check in info.\n\nDue to logistics we will be traveling to Portland with two cars. Can you recommend parking for the second vehicle? Is it possible to utilize another spot at the residence?\n\nPlease advise.\n\nThanks,\n\nJohn";
  const johnNoPartyMsg =
    'I think you misunderstood. Not looking to plan a gathering. Just need parking for a second car.';

  it('does not treat niece wedding + second-car parking as EVENT_REQUEST (John Apt 2)', async () => {
    const tool = new EventRequestTool();
    const result = await tool.execute(johnSecondCarMsg);
    assert.equal(result.detected, false);
    assert.equal(isAdditionalParkingAsk(johnSecondCarMsg), true);
    assert.equal(isTripPurposeEventMention(johnSecondCarMsg), true);
  });

  it('does not treat "not looking to plan a gathering" + second car as EVENT_REQUEST', async () => {
    const tool = new EventRequestTool();
    const result = await tool.execute(johnNoPartyMsg);
    assert.equal(result.detected, false);
    assert.equal(result.deniedEvent, true);
    assert.equal(isEventHostingDenial(johnNoPartyMsg), true);
    assert.equal(isAdditionalParkingAsk(johnNoPartyMsg), true);
  });

  const elizabethThirdDogMsg =
    "Hi again,  One last question.  In the unlikely event that our very senior dog is still around for Thanksgiving, will that be an issue?  She sleeps most of the time and goes on very short walks or goes in a doggy stroller.  Of course, I should've carefully read the listing about your 2 dog max";

  it('does not treat "in the unlikely event" + 2 dog max as EVENT_REQUEST (Elizabeth Apt 3)', async () => {
    const tool = new EventRequestTool();
    const result = await tool.execute(elizabethThirdDogMsg);
    assert.equal(result.detected, false);
    assert.equal(result.petOverMax, true);
    assert.equal(isPetOverMaxAsk(elizabethThirdDogMsg), true);
    assert.equal(isUnlikelyEventIdiom(elizabethThirdDogMsg), true);
  });

  it('skips event policy when LLM labels a 3rd-dog ask as EVENT_REQUEST', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyEventRequestPolicy(
      {
        typeOfMessageReceived: 'EVENT_REQUEST',
        proposedResponse: "Thank you for thinking of our place for your event! Unfortunately, we're not able to accommodate events or gatherings as this is a residential building and our apartment isn't set up for those types of activities. We appreciate your understanding and hope you find a perfect venue for your celebration!",
      },
      { guestName: 'Elizabeth', earlyEventDetection: { detected: true } },
      elizabethThirdDogMsg
    );
    assert.equal(applied.applied, false);
  });

  it('forces PET_QUESTIONS max-2-dogs copy for a third-dog ask (Elizabeth Apt 3)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyPetOverMaxPolicy(
      {
        typeOfMessageReceived: 'EVENT_REQUEST',
        proposedResponse: "Thank you for thinking of our place for your event! Unfortunately, we're not able to accommodate events or gatherings as this is a residential building and our apartment isn't set up for those types of activities. We appreciate your understanding and hope you find a perfect venue for your celebration!",
      },
      { guestName: 'Elizabeth' },
      elizabethThirdDogMsg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'PET_QUESTIONS');
    assert.match(applied.proposedResponse, /maximum 2 dogs/i);
    assert.doesNotMatch(applied.proposedResponse, /not able to accommodate events/i);
    assert.doesNotMatch(applied.proposedResponse, /perfect venue for your celebration/i);
    assert.match(PET_OVER_MAX_SNIPPET, /maximum 2 dogs/i);
  });

  it('skips event policy when LLM labels second-car parking as EVENT_REQUEST', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyEventRequestPolicy(
      {
        typeOfMessageReceived: 'EVENT_REQUEST',
        proposedResponse: "Thank you for thinking of our place for your event! Unfortunately, we're not able to accommodate events or gatherings as this is a residential building and our apartment isn't set up for those types of activities. We appreciate your understanding and hope you find a perfect venue for your celebration!",
      },
      { guestName: 'John', earlyEventDetection: { detected: true } },
      johnSecondCarMsg
    );
    assert.equal(applied.applied, false);
  });

  it('forces additional-parking copy (one on-site car + Vaughan) for second-car asks', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyAdditionalParkingPolicy(
      {
        typeOfMessageReceived: 'EVENT_REQUEST',
        proposedResponse: "Unfortunately, we're not able to accommodate events or gatherings.",
      },
      { guestName: 'John' },
      johnSecondCarMsg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'PARKING_ADDITIONAL_QUESTION');
    assert.match(applied.proposedResponse, /on-site parking for one car/i);
    assert.match(applied.proposedResponse, /Vaughan Street/);
    assert.match(applied.proposedResponse, /192-234/);
    assert.doesNotMatch(applied.proposedResponse, /not able to accommodate events/i);
  });

  it('thanks for confirming no party then gives second-car parking (John clarification)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyAdditionalParkingPolicy(
      {
        typeOfMessageReceived: 'EVENT_REQUEST',
        proposedResponse: "Unfortunately, we're not able to accommodate events or gatherings.",
      },
      { guestName: 'John' },
      johnNoPartyMsg
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /Thanks for confirming that you will not be hosting a party/);
    assert.match(applied.proposedResponse, /on-site parking for one car/i);
    assert.match(applied.proposedResponse, /Vaughan Street/);
    assert.match(applied.proposedResponse, /192-234/);
    assert.doesNotMatch(applied.proposedResponse, /not able to accommodate events/i);
    const seeded = additionalParkingDraft({ deniedEvent: true });
    assert.match(seeded, /Thanks for confirming that you will not be hosting a party/);
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
    assert.ok(applied.proposedResponse.includes('010-0004') || applied.proposedResponse.includes(TEST_HOST_CONTACTS.richardPhonePrimary));
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
    assert.ok(applied.proposedResponse.includes(TEST_HOST_CONTACTS.apt2StreetLockboxCode));
    assert.ok(/lock box/i.test(applied.proposedResponse));
    assert.ok(applied.proposedResponse.includes('top'));
    assert.ok(applied.proposedResponse.includes('0123'));
    assert.ok(applied.proposedResponse.includes(TEST_HOST_CONTACTS.jeromePhoneDisplay));
    assert.ok(applied.proposedResponse.includes(TEST_HOST_CONTACTS.rubyPhoneDisplay));
    assert.ok(applied.proposedResponse.includes(TEST_HOST_CONTACTS.richardPhoneDisplay));
    assert.ok(!/code for the outside door and unit is 8040/i.test(applied.proposedResponse));

    // LLM category correct but omits pin digits when phone is known → always force full script
    const missingPin = agent._applyApt2StreetDoorLockoutPolicy(
      {
        typeOfMessageReceived: 'APT2_STREET_DOOR_LOCKOUT',
        proposedResponse:
          `Sorry you're locked out! Top lock box ${TEST_HOST_CONTACTS.apt2StreetLockboxCode}. Put the key back. Call ${TEST_HOST_CONTACTS.jeromePhoneDisplay}, ${TEST_HOST_CONTACTS.rubyPhoneDisplay}, or ${TEST_HOST_CONTACTS.richardPhoneDisplay}.`,      },
      apt2,
      lockedOutMsg
    );
    assert.equal(missingPin.applied, true);
    assert.ok(missingPin.proposedResponse.includes('0123'));

    // Even a "complete" LLM draft is rewritten so pin digits cannot flake out of the keep-path
    const alreadyComplete = agent._applyApt2StreetDoorLockoutPolicy(
      {
        typeOfMessageReceived: 'APT2_STREET_DOOR_LOCKOUT',
        proposedResponse:
          `Sorry you're locked out! Top lock box ${TEST_HOST_CONTACTS.apt2StreetLockboxCode}. Put the key back. Use pin 0123. Call ${TEST_HOST_CONTACTS.jeromePhoneDisplay}, ${TEST_HOST_CONTACTS.rubyPhoneDisplay}, or ${TEST_HOST_CONTACTS.richardPhoneDisplay}.`,      },
      apt2,
      lockedOutMsg
    );
    assert.equal(alreadyComplete.applied, true);
    assert.ok(alreadyComplete.proposedResponse.includes('0123'));
    assert.ok(alreadyComplete.proposedResponse.includes(TEST_HOST_CONTACTS.apt2StreetLockboxCode));

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
    assert.ok(bolted.proposedResponse.includes(TEST_HOST_CONTACTS.apt2StreetLockboxCode));

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
      { typeOfMessageReceived: 'DOOR_CODE_ISSUE', proposedResponse: `Please try backup code ${TEST_HOST_CONTACTS.backupDoorCode}.` },
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

    // Henry review incident: prior lockout in history + post-stay thanks/review MUST NOT re-send lockout
    const historyWithPriorLockout = [
      {
        sender_type: 'guest',
        body: 'We accidentally locked the door not knowing that the front door locked and are unable to get into the Airbnb.',
      },
      { sender_type: 'host', body: `Sorry you're locked out! Top lock box ${TEST_HOST_CONTACTS.apt2StreetLockboxCode}...` },
      {
        sender_type: 'guest',
        body: 'We bolted the door from the inside',
      },
      { sender_type: 'host', body: 'Glad you got in!' },
    ];
    const postStayThanks =
      'Thanks so much Jerome and Ruby! We had a terrific trip to Portland and already looking forward to the next one. I’ll get a glowing review submitted today or tomorrow';
    const poisoned = agent._applyApt2StreetDoorLockoutPolicy(
      {
        typeOfMessageReceived: 'APT2_STREET_DOOR_LOCKOUT',
        proposedResponse: `Sorry you're locked out! Top lock box ${TEST_HOST_CONTACTS.apt2StreetLockboxCode}.`,
      },
      {
        ...apt2,
        checkIn: '2026-07-25T16:00:00-04:00',
        checkOut: '2026-07-26T10:00:00-04:00',
        asOfDate: '2026-07-27',
        conversationHistory: historyWithPriorLockout,
      },
      postStayThanks
    );
    assert.equal(poisoned.applied, false, 'must not apply lockout after post-stay review thank-you');

    // LLM category alone (false positive APT2) without lockout language must not force script
    const falseCat = agent._applyApt2StreetDoorLockoutPolicy(
      {
        typeOfMessageReceived: 'APT2_STREET_DOOR_LOCKOUT',
        proposedResponse: "Sorry you're locked out!",
      },
      {
        ...apt2,
        checkIn: '2026-07-25',
        checkOut: '2026-07-26',
        asOfDate: '2026-07-27',
        conversationHistory: historyWithPriorLockout,
      },
      postStayThanks
    );
    assert.equal(falseCat.applied, false);

    const reviewPolicy = agent._applyReviewPromisePolicy(
      {
        typeOfMessageReceived: 'APT2_STREET_DOOR_LOCKOUT',
        proposedResponse: `Sorry you're locked out! Top lock box ${TEST_HOST_CONTACTS.apt2StreetLockboxCode}.`,
      },
      {
        ...apt2,
        checkIn: '2026-07-25',
        checkOut: '2026-07-26',
        asOfDate: '2026-07-27',
      },
      postStayThanks
    );
    assert.equal(reviewPolicy.applied, true);
    assert.equal(reviewPolicy.typeOfMessageReceived, 'REVIEW_PROMISE');
    assert.ok(/you're welcome/i.test(reviewPolicy.proposedResponse));
    assert.ok(/review/i.test(reviewPolicy.proposedResponse));
    assert.ok(!/locked out|lock box/i.test(reviewPolicy.proposedResponse));
    assert.ok(!reviewPolicy.proposedResponse.includes(TEST_HOST_CONTACTS.apt2StreetLockboxCode));
  });

  it('processMessage injects pin 0123 for Apt 2 lockout even when LLM omits it (eval path)', async () => {
    // Mirrors CI flake: category correct + lockbox/contacts, missing required phrase "0123".
        const incompleteDraft =
      "Sorry you're locked out! On the street entrance door on the right, you will see two lock boxes. " +
      `The one at the top has the backup key — open it by rotating the digits to ${TEST_HOST_CONTACTS.apt2StreetLockboxCode}. ` +
      'Once you open the street door, put the key back in the lock box right away. ' +
      'After you go up the stairs, use your pin code (the last 4 digits of the phone number on your reservation) to enter the unit. ' +
      `If you have any trouble, call me at ${TEST_HOST_CONTACTS.jeromePhoneDisplay}, my wife Ruby at ${TEST_HOST_CONTACTS.rubyPhoneDisplay}, or Richard at ${TEST_HOST_CONTACTS.richardPhoneDisplay}.`;

    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'APT2_STREET_DOOR_LOCKOUT',
            shouldReply: true,
            confidence: 1.0,
            proposedResponse: incompleteDraft,
          }),
      },
    });

    const result = await agent.processMessage(
      'We accidentally locked the door not knowing that the front door locked and are unable to get into the Airbnb.',
      {
        guestName: 'Henry',
        checkIn: '2026-07-24',
        checkOut: '2026-07-26',
        asOfDate: '2026-07-25',
        listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
        propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
        guestPhone: '6468040123',
        conversationHistory: [],
      }
    );

    assert.equal(result.typeOfMessageReceived, 'APT2_STREET_DOOR_LOCKOUT');
    assert.equal(result.shouldReply, true);
    assert.ok(result.proposedResponse.includes('0123'), 'must include guest pin last-4');
    assert.ok(result.proposedResponse.includes(TEST_HOST_CONTACTS.apt2StreetLockboxCode));
    assert.ok(/lock box/i.test(result.proposedResponse));
    assert.ok(result.proposedResponse.includes(TEST_HOST_CONTACTS.jeromePhoneDisplay));
    assert.ok(result.proposedResponse.includes(TEST_HOST_CONTACTS.rubyPhoneDisplay));
    assert.ok(result.proposedResponse.includes(TEST_HOST_CONTACTS.richardPhoneDisplay));
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
        proposedResponse: `Please contact Richard at ${TEST_HOST_CONTACTS.richardPhonePrimary} to coordinate early drop-off.`,
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
    assert.ok(applied.proposedResponse.includes('same mode'));
    assert.ok(applied.proposedResponse.includes('living room'));
    assert.ok(applied.proposedResponse.includes('master bedroom'));
    assert.ok(applied.proposedResponse.includes('small bedroom'));
  });

  it('thermostat policy fills same-mode room names even when remotes wording is already present', async () => {
    const thermostatTool = new ThermostatTool();
    const listingId = '114663c5-0709-4eff-a868-fa9ebd6ed42d';
    const thermo = await thermostatTool.execute("How do I turn up the heat? It's cold in here.", {
      listingId,
      guestName: 'Casey'
    });
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyThermostatPolicy(
      {
        typeOfMessageReceived: 'THERMOSTAT_HEATPUMP',
        proposedResponse: 'Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat.',
      },
      { earlyThermostatInfo: thermo, listingId },
      "How do I turn up the heat? It's cold in here."
    );
    assert.equal(applied.applied, true);
    assert.ok(applied.proposedResponse.includes('same mode'));
    assert.ok(applied.proposedResponse.includes('living room'));
    assert.ok(applied.proposedResponse.includes('master bedroom'));
  });

  it('names Apt 3 rooms and mixed-mode rule in ThermostatTool how-to', async () => {
    const thermostatTool = new ThermostatTool();
    const thermo = await thermostatTool.execute("How do I turn on the heat? It's freezing in here.", {
      listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
      guestName: 'Ted',
    });
    const howTo = (thermo.howTo || []).join(' ');
    assert.match(howTo, /living room/);
    assert.match(howTo, /master bedroom/);
    assert.match(howTo, /small bedroom/);
    assert.match(howTo, /same mode/);
    assert.match(thermo.recommendedResponse, /same mode/);
    assert.match(thermo.recommendedResponse, /living room/);
  });

  it('HeatPumpTool mixed-mode snippet names which rooms are heat vs cool', async () => {
    const { HeatPumpTool } = await import('../src/tools/hvac/HeatPumpTool.js');
    const listingId = '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd';
    const live = {
      listingId,
      unitCount: 3,
      summary: { modes: ['heat', 'cool'], mixedModes: true, avgRoomTempF: 70 },
      units: [
        { deviceId: '7636c887-e946-4f55-9bd8-be9e0baa0bcd', roomName: 'living room', operationMode: 'heat', power: 1, roomTempF: 72 },
        { deviceId: '18df3129-0790-490e-9545-cacd399f71b7', roomName: 'master bedroom', operationMode: 'cool', power: 1, roomTempF: 70 },
        { deviceId: '30dc168d-698e-4218-b8d4-17d93cd15358', roomName: 'small bedroom', operationMode: 'heat', power: 1, roomTempF: 66 },
      ],
    };
    const fakeKumo = {
      getStatusForListing: async () => live,
      ensureConsistentForComplaint: async () => ({
        fixed: true,
        recommendedMode: 'auto',
        recommendedTempF: 65,
        before: live,
        setResult: { success: true },
      }),
    };
    const tool = new HeatPumpTool({ kumoClient: fakeKumo });
    const result = await tool.execute("The AC is on but there's no air and it's too hot", {
      listingId,
      guestName: 'Ted',
    });
    const snip = result.suggestedResponseSnippet || '';
    assert.match(snip, /living room/i);
    assert.match(snip, /master bedroom/i);
    assert.match(snip, /small bedroom/i);
    assert.match(snip, /same mode/);
    assert.match(snip, /on heat/);
    assert.match(snip, /on cool/);
    assert.match(snip, /set all/);
    assert.match(snip, /auto at 65/);
    assert.doesNotMatch(snip, /nest/i);
    assert.doesNotMatch(snip, /apt\s*3/i);
    assert.match(snip, /master bedroom is on cool/i);
  });

  it('HeatPumpTool turns all units off when the guest asks to turn it off remotely', async () => {
    const { HeatPumpTool } = await import('../src/tools/hvac/HeatPumpTool.js');
    const listingId = '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd';
    const live = {
      listingId,
      unitCount: 3,
      summary: { modes: ['heat'], mixedModes: false, avgRoomTempF: 70 },
      units: [
        { deviceId: '7636c887-e946-4f55-9bd8-be9e0baa0bcd', roomName: 'living room', operationMode: 'heat', power: 1 },
        { deviceId: '18df3129-0790-490e-9545-cacd399f71b7', roomName: 'master bedroom', operationMode: 'heat', power: 1 },
        { deviceId: '30dc168d-698e-4218-b8d4-17d93cd15358', roomName: 'small bedroom', operationMode: 'heat', power: 1 },
      ],
    };
    let offCalled = false;
    const fakeKumo = {
      getStatusForListing: async () => live,
      setAllUnitsOff: async () => {
        offCalled = true;
        return { success: true, power: 0, unitsSet: 3 };
      },
      ensureConsistentForComplaint: async () => {
        throw new Error('must not auto-set heat/cool on a turn-off ask');
      },
    };
    const tool = new HeatPumpTool({ kumoClient: fakeKumo });
    const msg = 'Hi sorry about that. I thought I had turned it off. I may have set it to heat. We are currently away. Are you able to turn it off remotely or is it ok to leave as is for now';
    const result = await tool.execute(msg, { listingId, guestName: 'Ted' });
    assert.equal(offCalled, true);
    assert.equal(result.actionTaken.turnedOff, true);
    assert.match(result.suggestedResponseSnippet, /I turned the wall units off/);
    assert.doesNotMatch(result.suggestedResponseSnippet, /message us when you'd like them back on/i);
    assert.doesNotMatch(result.suggestedResponseSnippet, /nest/i);
    assert.doesNotMatch(result.suggestedResponseSnippet, /make sure you are using/i);
  });

  it('thermostat policy does not re-stamp Nest when prior host HVAC advice exists', async () => {
    const thermostatTool = new ThermostatTool();
    const listingId = '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd';
    const msg = 'Hi sorry about that. I thought I had turned it off. I may have set it to heat. We are currently away. Are you able to turn it off remotely or is it ok to leave as is for now';
    const thermo = await thermostatTool.execute(msg, { listingId, guestName: 'Ted' });
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyThermostatPolicy(
      {
        typeOfMessageReceived: 'THERMOSTAT_HEATPUMP',
        proposedResponse: 'Ted, Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat.',
      },
      {
        listingId,
        earlyThermostatInfo: thermo,
        conversationTraces: {
          priorHostHVACAdvice: 'Use the remotes on the wall in each room',
          repeatedInstructionRisk: true,
        },
        heatPumpInfo: {
          guestMessageRelevant: true,
          suggestedResponseSnippet: 'Yes, I turned the wall units off for you. Enjoy your time away.',
          actionTaken: { turnedOff: true },
        },
      },
      msg
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /I turned the wall units off/);
    assert.doesNotMatch(applied.proposedResponse, /nest/i);
    assert.doesNotMatch(applied.proposedResponse, /make sure you are using/i);
  });

  it('judge prompt includes the full thread not a short newest-first slice', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const history = [];
    for (let i = 1; i <= 12; i++) {
      history.push({
        sender_type: i % 2 ? 'guest' : 'host',
        body: `turn-${i}-unique-body`,
        created_at: `2026-09-04T${String(10 + i).padStart(2, '0')}:00:00Z`,
      });
    }
    const prompt = await agent._buildConversationJudgePrompt(
      { typeOfMessageReceived: 'THERMOSTAT_HEATPUMP', proposedResponse: 'Hello' },
      {},
      { conversationHistory: history, originalMessage: 'Are you able to turn it off remotely' }
    );
    assert.match(prompt, /FULL CONVERSATION HISTORY/);
    assert.match(prompt, /turn-1-unique-body/);
    assert.match(prompt, /turn-12-unique-body/);
  });

  it('deterministic HVAC judge guard revises Nest lecture into turn-off confirm', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'We are currently away. Are you able to turn it off remotely or is it ok to leave as is for now';
    const guarded = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', notes: 'ok', issues: [] },
      {
        typeOfMessageReceived: 'THERMOSTAT_HEATPUMP',
        proposedResponse: 'Ted, Please make sure you are using the heat pump remotes on the wall in each room — the Nest thermostat (if you see one) does not control the AC or heat.',
      },
      {
        conversationTraces: { priorHostHVACAdvice: 'Use the remotes on the wall in each room', repeatedInstructionRisk: true },
        heatPumpInfo: {
          actionTaken: { turnedOff: true },
          suggestedResponseSnippet: 'Yes, I turned the wall units off for you. Enjoy your time away.',
        },
      },
      msg
    );
    assert.equal(guarded.verdict, 'REVISE');
    assert.equal(guarded.deterministicGuard, true);
    assert.match(guarded.revisedResponse, /I turned the wall units off/);
    assert.doesNotMatch(guarded.revisedResponse, /nest/i);
  });

  it('normalizes Hospitable newest-first threads so the latest host turn is last', async () => {
    const { normalizeThreadChronological } = await import('../src/utils/threadHistory.js');
    const newestFirst = [
      { body: 'latest host remotes note', sender_type: 'host', created_at: '2026-09-05T15:14:19Z' },
      { body: 'middle guest', sender_type: 'guest', created_at: '2026-09-04T18:00:00Z' },
      { body: 'oldest welcome', sender_type: 'host', created_at: '2026-09-01T12:00:00Z' },
    ];
    const chrono = normalizeThreadChronological(newestFirst);
    assert.equal(chrono[0].body, 'oldest welcome');
    assert.equal(chrono[chrono.length - 1].body, 'latest host remotes note');
    const slicedWrong = newestFirst.slice(-2).map((m) => m.body);
    assert.ok(slicedWrong.includes('oldest welcome'));
    assert.equal(chrono.slice(-1)[0].body, 'latest host remotes note');
  });

  it('host mixed-mode notice names the odd room first and omits Nest and unit number', async () => {
    const { buildHostMixedModeNotice } = await import('../src/tools/hvac/headLayout.js');
    const body = buildHostMixedModeNotice({
      guestName: 'Ted',
      rooms: ['living room', 'master bedroom', 'small bedroom'],
      units: [
        { roomName: 'living room', operationMode: 'cool' },
        { roomName: 'master bedroom', operationMode: 'cool' },
        { roomName: 'small bedroom', operationMode: 'heat' },
      ],
    });
    assert.match(body, /^Hi Ted,/);
    assert.match(body, /small bedroom is on heat/i);
    assert.match(body, /living room and master bedroom are on cool/i);
    assert.match(body, /same mode/);
    assert.doesNotMatch(body, /nest/i);
    assert.doesNotMatch(body, /apt\s*3/i);
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

  it('HARDENING: Roberto short "Ok" first host on new booking must force NEW_RESERVATION_WELCOME + reply', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg = 'Ok';
    const ctx = {
      reservationId: '512e11da-a9b7-4b80-bb9c-bd422243053a',
      guestName: 'Roberto',
      guestDisplayName: 'Roberto',
      checkIn: '2026-08-04T16:00:00-04:00',
      checkOut: '2026-08-05T10:00:00-04:00',
      listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
      propertyName: 'Cozy, Central 2 Bd Apt, Parking',
      conversationHistory: [],
      conversationTraces: {
        hasRecentHostMessage: false,
        historySource: 'live_fetched',
        recentMessageCount: 1,
        greeting: {
          isFirstHostMessage: true,
          numHostMessages: 0,
          numGuestMessages: 1,
          shouldUseGreeting: true,
          timeBasedGreeting: 'Good afternoon',
        },
      },
    };
    assert.equal(agent._isFirstHostOnConfirmedReservation(ctx), true);
    assert.equal(agent._isShortNewBookingAck(msg), true);
    assert.equal(agent._isPureFirstPostBookingIntro(msg, ctx), false, 'short Ok is not pure-intro (≥25 chars)');

    const applied = agent._applyFirstHostNewBookingWelcomePolicy(
      {
        typeOfMessageReceived: 'OTHER_MESSAGE',
        proposedResponse: 'none',
        shouldReply: false,
        escalated: true,
        confidence: 1.0,
      },
      ctx,
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.escalated, false);
    assert.equal(applied.typeOfMessageReceived, 'NEW_RESERVATION_WELCOME');
    assert.equal(applied.confidence, 1.0);
    assert.ok(applied.proposedResponse && applied.proposedResponse !== 'none');
    assert.match(applied.proposedResponse, /Roberto/i);
    assert.match(applied.proposedResponse, /4pm/i);
    assert.match(applied.proposedResponse, /self-check-in/i);
    assert.match(applied.proposedResponse, /parking/i);
    assert.doesNotMatch(applied.proposedResponse, /let me know if you have any questions/i);
  });

  it('HARDENING: first-host welcome is not applied after host already messaged', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const ctx = {
      reservationId: '512e11da-a9b7-4b80-bb9c-bd422243053a',
      conversationTraces: {
        hasRecentHostMessage: true,
        recentWelcomeSent: true,
        greeting: { isFirstHostMessage: false, numHostMessages: 1 },
      },
    };
    assert.equal(agent._isFirstHostOnConfirmedReservation(ctx), false);
    const applied = agent._applyFirstHostNewBookingWelcomePolicy(
      { typeOfMessageReceived: 'OTHER_MESSAGE', proposedResponse: 'none', shouldReply: false },
      ctx,
      'Ok'
    );
    assert.equal(applied.applied, false);
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

  it('CancellationTool detects already-cancelled status and blocks policy link (Julia incident)', async () => {
    const { CancellationTool } = await import('../src/tools/cancellation/CancellationTool.js');
    const tool = new CancellationTool();
    const msg =
      "Unfortunately we will need to leave tomorrow morning. My mom had a serious medical emergency. I'm wondering what our cancellation options are.";
    const result = await tool.execute(msg, {
      guestName: 'Julia',
      reservationStatus: 'cancelled',
      checkIn: '2026-07-25',
      checkOut: '2026-07-28',
    });
    assert.equal(result.alreadyCancelled, true);
    assert.equal(result.includePolicyLink, false);
    assert.equal(result.officialPolicyUrl, null);
    assert.equal(result.needsEscalation, false);
    assert.equal(result.recommendedAction, 'acknowledge_already_cancelled');
    assert.match(result.policyNote || '', /Do NOT include/i);
  });

  it('CancellationTool still offers policy link when reservation is accepted', async () => {
    const { CancellationTool } = await import('../src/tools/cancellation/CancellationTool.js');
    const tool = new CancellationTool();
    const result = await tool.execute('What refund would we get if we cancel?', {
      reservationStatus: 'accepted',
      bookingTimestamp: '2026-05-01T12:00:00Z',
      checkIn: '2026-08-01',
    });
    assert.equal(result.alreadyCancelled, false);
    assert.equal(result.includePolicyLink, true);
    assert.ok(result.officialPolicyUrl?.includes('help/article/475'));
  });

  it('detects pending→just-accepted and not instant book (reservationAccept util)', async () => {
    const {
      analyzeReservationAccept,
      shouldProcessAcceptWelcome,
      ensureJustAcceptedOpener,
      JUST_ACCEPTED_INQUIRY_OPENER,
    } = await import('../src/utils/reservationAccept.js');

    const now = '2026-08-01T02:22:00.000Z';
    const pendingThenAccept = {
      status: 'accepted',
      reservation_status: {
        current: { category: 'accepted' },
        history: [
          { category: 'request', changed_at: '2026-08-01T01:03:10+00:00', sub_category: 'request to book' },
          { category: 'accepted', changed_at: '2026-08-01T02:19:54+00:00', sub_category: null },
        ],
      },
    };
    const a = analyzeReservationAccept(pendingThenAccept, { now });
    assert.equal(a.wasPendingBeforeAccept, true);
    assert.equal(a.isInstantBookStyle, false);
    assert.equal(a.justAcceptedFromPending, true);
    assert.equal(shouldProcessAcceptWelcome(a), true);

    const instant = analyzeReservationAccept(
      {
        status: 'accepted',
        reservation_status: {
          current: { category: 'accepted' },
          history: [{ category: 'accepted', changed_at: '2026-08-01T02:19:54+00:00' }],
        },
      },
      { now }
    );
    assert.equal(instant.isInstantBookStyle, true);
    assert.equal(instant.justAcceptedFromPending, false);
    assert.equal(shouldProcessAcceptWelcome(instant), false);

    const stale = analyzeReservationAccept(pendingThenAccept, {
      now: '2026-08-01T03:00:00.000Z', // >5 min after accept
    });
    assert.equal(stale.justAcceptedFromPending, false);
    assert.equal(shouldProcessAcceptWelcome(stale), false);

    const withGreeting = ensureJustAcceptedOpener(
      'Good afternoon, Dashiell, Welcome! Check-in is at 4pm with self-check-in and parking.',
      'Dashiell'
    );
    assert.match(withGreeting, new RegExp(JUST_ACCEPTED_INQUIRY_OPENER, 'i'));
    assert.match(withGreeting, /Good afternoon, Dashiell/i);
    assert.match(withGreeting, /4pm/i);
  });

  it('applies "I just accepted your inquiry" opener via agent policy', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyJustAcceptedInquiryPolicy(
      {
        typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
        proposedResponse:
          'Good afternoon, Dashiell, Welcome! Check-in is at 4pm with self-check-in. I will send the detailed check-in instructions 3 days before your arrival.',
        shouldReply: true,
      },
      {
        guestName: 'Dashiell',
        justAcceptedInquiry: true,
        acceptAnalysis: { isInstantBookStyle: false },
      },
      'Looking forward to the stay'
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /I just accepted your inquiry/i);
    assert.equal(applied.shouldReply, true);
  });

  it('does not apply accept opener for instant book analysis', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const applied = agent._applyJustAcceptedInquiryPolicy(
      {
        typeOfMessageReceived: 'NEW_RESERVATION_WELCOME',
        proposedResponse: 'Good afternoon, Hammad, Welcome! Check-in is at 4pm.',
        shouldReply: true,
      },
      {
        guestName: 'Hammad',
        justAcceptedInquiry: true,
        acceptAnalysis: { isInstantBookStyle: true },
      },
      'Hello'
    );
    assert.equal(applied.applied, false);
  });

  it('strips policy link when reservation already cancelled (Julia deterministic policy)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg =
      "I'm wondering what our cancellation options are. My mom had a serious medical emergency.";
    const ctx = {
      guestName: 'Julia',
      reservationStatus: 'cancelled',
      checkIn: '2026-07-25',
      checkOut: '2026-07-28',
    };
    const badDraft =
      "Good afternoon Julia, so sorry to hear about the medical emergency. For details on cancellation options, please see Airbnb's official policy page: https://www.airbnb.com/help/article/475";
    const applied = agent._applyAlreadyCancelledPolicy(
      {
        typeOfMessageReceived: 'CANCELLATION_POLICY_EXCEPTION',
        proposedResponse: badDraft,
        shouldReply: true,
        cancellationInfo: { alreadyCancelled: true, reservationStatus: 'cancelled' },
      },
      ctx,
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.escalated, false);
    assert.equal(applied.typeOfMessageReceived, 'CANCELLATION_NOTIFICATION');
    assert.doesNotMatch(applied.proposedResponse, /help\/article\/475/i);
    assert.doesNotMatch(applied.proposedResponse, /cancellation options/i);
    assert.match(applied.proposedResponse, /already cancelled/i);
  });

  it('always auto-replies latest checkout time with 10am (production miss)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const msg =
      'Sounds great! Thank you! And what is the latest time we are able to check out Monday?';
    const applied = agent._applyLatestCheckoutTimePolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: 'none',
        shouldReply: false,
        confidence: 0.4,
      },
      { guestName: 'Guest' },
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.confidence, 1.0);
    assert.deepEqual(applied.typeOfMessageReceived, ['THANK_YOU_MESSAGE', 'CHECKOUT']);
    assert.match(applied.proposedResponse, /10am/i);
    assert.match(applied.proposedResponse, /checkout is strictly/i);
    assert.match(applied.proposedResponse, /welcome/i);
  });

  it('high-confidence force-reply: sendable draft + conf>=0.9 forces shouldReply', async () => {
    const { applyHighConfidenceForceReply, isOperationalMustReplyAsk, buildProductionMissScenario } =
      await import('../src/utils/replyPolicy.js');

    const forced = applyHighConfidenceForceReply({
      shouldReply: false,
      confidence: 0.95,
      proposedResponse: "You're welcome! Checkout is strictly at 10am.",
      typeOfMessageReceived: ['THANK_YOU_MESSAGE', 'CHECKOUT'],
      guestMessage:
        'Sounds great! Thank you! And what is the latest time we are able to check out Monday?',
    });
    assert.equal(forced.shouldReply, true);
    assert.ok(forced.reason);

    // Operational multi-intent ask at medium-high conf
    assert.equal(
      isOperationalMustReplyAsk(
        'Sounds great! Thank you! And what is the latest time we are able to check out Monday?'
      ),
      true
    );
    const op = applyHighConfidenceForceReply({
      shouldReply: false,
      confidence: 0.8,
      proposedResponse: 'Checkout is strictly at 10am.',
      typeOfMessageReceived: 'CHECKOUT',
      guestMessage:
        'Sounds great! Thank you! And what is the latest time we are able to check out Monday?',
    });
    assert.equal(op.shouldReply, true);

    // Pure OTHER_MESSAGE alone is not forced
    const other = applyHighConfidenceForceReply({
      shouldReply: false,
      confidence: 0.99,
      proposedResponse: 'Thanks for letting us know.',
      typeOfMessageReceived: 'OTHER_MESSAGE',
      guestMessage: 'just fyi nothing needed',
    });
    assert.equal(other.shouldReply, false);

    const scen = buildProductionMissScenario({
      id: 'demo-miss',
      guestMessage: 'What is the wifi password?',
      requiredPhrases: ['wifi'],
      expectedCategory: 'WIFI',
    });
    assert.equal(scen.productionMiss, true);
    assert.equal(scen.rubric.shouldAlwaysReply, true);
    assert.equal(scen.rubric.shouldReply, true);
    assert.ok(scen.rubric.minConfidence >= 0.95);
  });

  it('HARDENING: Amber shuttle + rainy-day ask is an operational must-reply even when escalated', async () => {
    const { applyHighConfidenceForceReply, isOperationalMustReplyAsk } =
      await import('../src/utils/replyPolicy.js');
    const amber =
      "I saw the guidebook, thank you! We ended up having to drive my husband to the airport at 4:30am because we were unprepared for a taxi and Uber dead zone at that time lol. He'll be back at 1am early Wednesday before we check out. Is there a shuttle your recommend so I'm not dragging the kids out of bed again?\n\nAlso keeping my girls occupied in the city on a rainy day? Most of my big plans were outdoors.";
    assert.equal(isOperationalMustReplyAsk(amber), true);

    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._guestAsksNewQuestion(amber, ['THANKS', 'TRANSPORT_QUESTION', 'ACTIVITIES_QUESTION']), true);
    assert.equal(agent._hasSafeAutoReplyCategory({ typeOfMessageReceived: ['THANKS', 'TRANSPORT_QUESTION'] }), true);

    const forced = applyHighConfidenceForceReply({
      shouldReply: false,
      confidence: 0.9,
      proposedResponse:
        "You're welcome, Amber! For the 1am airport run, the Portland Jetport shared-ride shuttle works well. For rainy days with the girls, the Children's Museum of Maine is a great indoor option.",
      escalated: true,
      typeOfMessageReceived: ['THANKS', 'TRANSPORT_QUESTION', 'ACTIVITIES_QUESTION'],
      guestMessage: amber,
    });
    assert.equal(forced.shouldReply, true);
    assert.ok(forced.reason);
  });

  it('HARDENING: thanks + shuttle/rainy-day forces a draft when Grok returns OTHER_MESSAGE + none', () => {
    const amber =
      "I saw the guidebook, thank you! We ended up having to drive my husband to the airport at 4:30am because we were unprepared for a taxi and Uber dead zone at that time lol. He'll be back at 1am early Wednesday before we check out. Is there a shuttle your recommend so I'm not dragging the kids out of bed again?\n\nAlso keeping my girls occupied in the city on a rainy day? Most of my big plans were outdoors.";
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyThanksPlusTransportActivitiesPolicy(
      { typeOfMessageReceived: 'OTHER_MESSAGE', proposedResponse: 'none', shouldReply: false, confidence: 0.4 },
      { guestName: 'Amber' },
      amber
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.confidence, 1.0);
    assert.deepEqual(applied.typeOfMessageReceived, ['THANKS', 'TRANSPORT_QUESTION', 'ACTIVITIES_QUESTION']);
    assert.match(applied.proposedResponse, /you're welcome, amber/i);
    assert.match(applied.proposedResponse, /taxi|shuttle/i);
    assert.match(applied.proposedResponse, /museum|library|indoor/i);
  });

  it('HARDENING: processMessage still sends Amber-class ask when first-pass draft is none', async () => {
    const amber =
      "I saw the guidebook, thank you! We ended up having to drive my husband to the airport at 4:30am because we were unprepared for a taxi and Uber dead zone at that time lol. He'll be back at 1am early Wednesday before we check out. Is there a shuttle your recommend so I'm not dragging the kids out of bed again?\n\nAlso keeping my girls occupied in the city on a rainy day? Most of my big plans were outdoors.";
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'OTHER_MESSAGE',
            proposedResponse: 'none',
            shouldReply: false,
            confidence: 0.4,
          }),
      },
    });
    const result = await agent.processMessage(amber, {
      guestName: 'Amber',
      reservationId: '48da4e7d-4aa9-43bf-8fc7-dd0ed7ea6a16',
      recentHostActivity: true,
      conversationTraces: { hasRecentHostMessage: true, minutesSinceLastHostMessage: 5.1 },
      conversationHistory: [
        {
          sender_type: 'host',
          body: 'Good morning Amber, I hope that you have settled in.',
        },
      ],
    });
    assert.equal(result.shouldReply, true);
    assert.match(result.proposedResponse, /you're welcome, amber/i);
    assert.ok(
      Array.isArray(result.typeOfMessageReceived)
        ? result.typeOfMessageReceived.includes('TRANSPORT_QUESTION')
        : result.typeOfMessageReceived === 'TRANSPORT_QUESTION'
    );
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

  it('rewrites Cassidy own-spot leave-the-car yes (production miss)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const msg =
      'Hi! We were also wondering for tomorrow if we could leave the car in the parking spot during the day as we walk around? And what would be the latest check out time?';
    const applied = agent._applyPostCheckoutParkingPolicy(
      {
        typeOfMessageReceived: 'PARKING',
        proposedResponse:
          'Good evening, Cassidy, yes you can leave the car in your dedicated spot while you walk around tomorrow. Checkout is strictly at 10am.',
        shouldReply: true,
      },
      {
        guestName: 'Cassidy',
        listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
        checkOut: '2026-08-17',
        asOfInstant: '2026-08-16T17:56:00-04:00',
        postCheckoutParkingInfo: { detected: true, exceptionEligible: false },
      },
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.match(applied.proposedResponse, /10am/i);
    assert.match(applied.proposedResponse, /cleaning team/i);
    assert.match(applied.proposedResponse, /clean the unit/i);
    assert.match(applied.proposedResponse, /next guests/i);
    assert.doesNotMatch(applied.proposedResponse, /yes you can leave the car/i);
    assert.doesNotMatch(applied.proposedResponse, /leave the car in your dedicated/i);
    assert.doesNotMatch(applied.proposedResponse, /1B parking spot/i);
  });

  it('offers vacant sibling spot until 1pm only when all exception conditions hold', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const msg =
      'Hi! We were also wondering for tomorrow if we could leave the car in the parking spot during the day as we walk around? And what would be the latest check out time?';
    const applied = agent._applyPostCheckoutParkingPolicy(
      { typeOfMessageReceived: 'PARKING', proposedResponse: 'none', shouldReply: false },
      {
        guestName: 'Cassidy',
        listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
        checkOut: '2026-08-17',
        asOfInstant: '2026-08-16T20:30:00-04:00',
        postCheckoutParkingInfo: {
          detected: true,
          exceptionEligible: true,
          vacantSibling: {
            shortName: '1B',
            listingId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
            spotLabel: '1B parking spot',
          },
        },
      },
      msg
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /1B parking spot/i);
    assert.match(applied.proposedResponse, /1pm/i);
    assert.match(applied.proposedResponse, /current spot/i);
    assert.match(applied.proposedResponse, /10am/i);
    assert.match(applied.proposedResponse, /cleaning team/i);
    assert.match(applied.proposedResponse, /clean the unit/i);
    assert.match(applied.proposedResponse, /next guests/i);
    assert.doesNotMatch(applied.proposedResponse, /yes you can leave the car in your dedicated/i);
  });

  it('names Apt 3 parking spot when that sibling is the vacant exception', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyPostCheckoutParkingPolicy(
      { typeOfMessageReceived: 'PARKING', proposedResponse: 'none', shouldReply: false },
      {
        guestName: 'Cassidy',
        listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
        checkOut: '2026-08-17',
        asOfInstant: '2026-08-16T20:30:00-04:00',
        postCheckoutParkingInfo: {
          detected: true,
          exceptionEligible: true,
          vacantSibling: {
            shortName: 'Apt 3',
            listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
            spotLabel: 'Apt 3 parking spot',
          },
        },
      },
      'Could we leave the car in the parking spot during the day tomorrow?'
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /Apt 3 parking spot/i);
    assert.match(applied.proposedResponse, /cleaning team/i);
    assert.match(applied.proposedResponse, /clean the unit/i);
    assert.doesNotMatch(applied.proposedResponse, /1B parking spot/i);
  });

  it('does not treat Amie pre-check-in parking as post-checkout car leave', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const msg = 'Hi are we able to park in the designated spot before the check in time at 4?';
    assert.equal(agent._isPostCheckoutParkingAsk(msg), false);
    const applied = agent._applyPostCheckoutParkingPolicy(
      { proposedResponse: 'Check-in is at 4pm.' },
      {},
      msg
    );
    assert.equal(applied.applied, false);
  });
});

describe('PostCheckoutParkingTool (mocked Hospitable, no LLM)', () => {
  const cassidyMsg =
    'Hi! We were also wondering for tomorrow if we could leave the car in the parking spot during the day as we walk around? And what would be the latest check out time?';
  const apt2 = '114663c5-0709-4eff-a868-fa9ebd6ed42d';
  const apt1b = 'c899481f-2e5b-402d-80c4-3167fd824d96';
  const apt3 = '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd';

  function mockOcc(occupiedByListing) {
    return {
      async hasGuestsOnDate(listingId) {
        return !!occupiedByListing[listingId];
      },
    };
  }

  const cassidyCtx = (asOfInstant) => ({
    guestName: 'Cassidy',
    listingId: apt2,
    checkIn: '2026-08-16',
    checkOut: '2026-08-17',
    propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
    asOfInstant,
  });

  it('detects Cassidy leave-the-car + latest checkout ask', () => {
    assert.equal(PostCheckoutParkingTool.looksLikePostCheckoutParkingAsk(cassidyMsg), true);
    assert.equal(
      PostCheckoutParkingTool.looksLikePostCheckoutParkingAsk(
        'Hi Jerome, we are about to check out. Would it be okay for us to leave the car for an hour or so while we walk to get breakfast?'
      ),
      true
    );
    assert.equal(
      PostCheckoutParkingTool.looksLikePostCheckoutParkingAsk(
        'Hi are we able to park in the designated spot before the check in time at 4?'
      ),
      false
    );
  });

  it('refuses own spot before 8pm ET even if 1B is vacant (Cassidy 5:56pm)', async () => {
    const tool = new PostCheckoutParkingTool({
      hospitableClient: mockOcc({ [apt1b]: false, [apt3]: true }),
    });
    const result = await tool.execute(cassidyMsg, cassidyCtx('2026-08-16T17:56:00-04:00'));
    assert.equal(result.detected, true);
    assert.equal(result.isDayBeforeCheckout, true);
    assert.equal(result.isAfter8pmEt, false);
    assert.equal(result.exceptionEligible, false);
    assert.equal(result.vacantSibling, null);
    assert.match(result.suggestedResponseSnippet, /10am/i);
    assert.match(result.suggestedResponseSnippet, /cleaning team/i);
    assert.match(result.suggestedResponseSnippet, /clean the unit/i);
    assert.match(result.suggestedResponseSnippet, /next guests/i);
    assert.doesNotMatch(result.suggestedResponseSnippet, /1B parking spot/i);
  });

  it('offers 1B until 1pm after 8pm ET when 1B is vacant that night', async () => {
    const tool = new PostCheckoutParkingTool({
      hospitableClient: mockOcc({ [apt1b]: false, [apt3]: true }),
    });
    const result = await tool.execute(cassidyMsg, cassidyCtx('2026-08-16T20:30:00-04:00'));
    assert.equal(result.detected, true);
    assert.equal(result.isDayBeforeCheckout, true);
    assert.equal(result.isAfter8pmEt, true);
    assert.equal(result.occupancyChecked, true);
    assert.equal(result.exceptionEligible, true);
    assert.equal(result.vacantSibling.shortName, '1B');
    assert.equal(result.vacantSibling.spotLabel, '1B parking spot');
    assert.match(result.suggestedResponseSnippet, /1B parking spot/i);
    assert.match(result.suggestedResponseSnippet, /1pm/i);
    assert.match(result.suggestedResponseSnippet, /current spot/i);
    assert.match(result.suggestedResponseSnippet, /cleaning team/i);
    assert.match(result.suggestedResponseSnippet, /clean the unit/i);
  });

  it('does not offer a sibling when every other unit is occupied that night', async () => {
    const tool = new PostCheckoutParkingTool({
      hospitableClient: mockOcc({ [apt1b]: true, [apt3]: true }),
    });
    const result = await tool.execute(cassidyMsg, cassidyCtx('2026-08-16T20:30:00-04:00'));
    assert.equal(result.exceptionEligible, false);
    assert.equal(result.vacantSibling, null);
    assert.doesNotMatch(result.suggestedResponseSnippet, /1B|Apt 3/i);
  });

  it('does not offer the exception on checkout morning (Olivia class)', async () => {
    const tool = new PostCheckoutParkingTool({
      hospitableClient: mockOcc({ [apt1b]: false, [apt3]: false }),
    });
    const result = await tool.execute(
      'Hi Jerome, we are about to check out. Would it be okay for us to leave the car for an hour or so while we walk to get breakfast?',
      {
        guestName: 'Olivia',
        listingId: apt2,
        checkIn: '2026-07-29',
        checkOut: '2026-07-30',
        asOfInstant: '2026-07-30T06:53:00-04:00',
      }
    );
    assert.equal(result.detected, true);
    assert.equal(result.isDayBeforeCheckout, false);
    assert.equal(result.exceptionEligible, false);
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
    assert.match(prompt, /FULL CONVERSATION HISTORY/);
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
    const missingGreeting = agent._applySofaBedLinensPolicy(
      {
        typeOfMessageReceived: 'SLEEPING_ARRANGEMENTS',
        proposedResponse: "You're welcome! Yes the sofa has linens in the storage compartment.",
      },
      { checkIn: '2026-07-18', guestName: 'Amy' },
      msg
    );
    assert.equal(missingGreeting.applied, true);
    assert.match(missingGreeting.proposedResponse, /^Good (morning|afternoon|evening)/i);
    assert.match(missingGreeting.proposedResponse, /sheets/i);
    assert.match(missingGreeting.proposedResponse, /blankets/i);
    assert.match(missingGreeting.proposedResponse, /storage compartment/i);
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

  it('does not treat hour-based early check-in as stay extension (Olivia)', () => {
    const olivia =
      "Hi Jerome - I'm flying into Portland tomorrow morning and landing around 9AM. Is there any opportunity for an early check in? If so, please let me know what time we'd be able to arrive. We're also planning to leave early on Sunday (by/before 9AM), so I will message you when we depart in case you want to start the cleaning process early.";
    assert.equal(StayExtensionTool.looksLikeFullDayExtension(olivia), false);
  });

  it('detects Anna-style earlier stay + 10/15 and requires alteration request when free', async () => {
    const annaMsg =
      "Hello! I'm wondering if it might be possible to begin our stay one night earlier — on Thursday, 10/15? We are looking into flights to Portland instead of a car. Are you open to this? Obviously we would pay for the additional evening.";
    assert.equal(StayExtensionTool.looksLikeFullDayExtension(annaMsg), true);

    const mockClient = {
      async getPropertyCalendar(_id, _start, _end) {
        return [
          { date: '2026-10-14', available: true },
          { date: '2026-10-15', available: true },
          { date: '2026-10-16', available: false },
          { date: '2026-10-17', available: false },
        ];
      },
    };
    const tool = new StayExtensionTool({ hospitableClient: mockClient });
    const result = await tool.execute(annaMsg, {
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      checkIn: '2026-10-16',
      checkOut: '2026-10-18',
      propertyName: '53 Pine St #2 · 1875 West End Victorian | EV Charging + Parking',
    });
    assert.equal(result.detected, true);
    assert.equal(result.extensionType, 'earlier_checkin');
    assert.equal(result.proposedCheckIn, '2026-10-15');
    assert.deepEqual(result.extraNights, ['2026-10-15']);
    assert.equal(result.calendarChecked, true);
    assert.equal(result.allAvailable, true);
    assert.match(result.suggestedResponseSnippet, /alteration request/i);
    assert.match(result.suggestedResponseSnippet, /53 Pine St #2/i);

    const blockedClient = {
      async getPropertyCalendar() {
        return [{ date: '2026-10-15', available: false }];
      },
    };
    const blocked = await new StayExtensionTool({ hospitableClient: blockedClient }).execute(annaMsg, {
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      checkIn: '2026-10-16',
      checkOut: '2026-10-18',
      propertyName: '53 Pine St #2 · 1875 West End Victorian | EV Charging + Parking',
    });
    assert.equal(blocked.allAvailable, false);
    assert.ok(blocked.unavailableDates.includes('2026-10-15'));
    assert.match(blocked.suggestedResponseSnippet, /already booked|not available/i);
    assert.doesNotMatch(blocked.suggestedResponseSnippet, /alteration request/i);

    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._looksLikeStayExtensionRequest(annaMsg, {
      checkIn: '2026-10-16',
      checkOut: '2026-10-18',
    }), true);
  });

  it('StayExtensionTool still handles Lilly later-checkout unavailable', async () => {
    const msg = "Hello, I'm wondering if I could extend our stay by one day -- instead of checking out on 28th, we'd check out on the 29th. Let me know, thanks!";
    const tool = new StayExtensionTool({
      hospitableClient: {
        async getPropertyCalendar() {
          return [{ date: '2026-09-29', available: false }];
        },
      },
    });
    const result = await tool.execute(msg, {
      listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
      checkIn: '2026-09-26',
      checkOut: '2026-09-29',
      propertyName: '53 Pine St #3 · 1875 West End Victorian',
    });
    assert.equal(result.detected, true);
    assert.equal(result.extensionType, 'later_checkout');
    assert.deepEqual(result.extraNights, ['2026-09-29']);
    assert.equal(result.allAvailable, false);
  });

  it('StayExtensionTool reads Hospitable status.available nested day objects', async () => {
    const annaMsg =
      "Hello! I'm wondering if it might be possible to begin our stay one night earlier — on Thursday, 10/15?";
    const tool = new StayExtensionTool({
      hospitableClient: {
        async getPropertyCalendar() {
          // Live Hospitable shape after client unwraps data.days
          return [
            {
              date: '2026-10-15',
              status: { reason: 'RESERVED', available: false },
            },
          ];
        },
        async getPropertyReservations() {
          return [
            {
              id: 'james-1night',
              check_in: '2026-10-15T16:00:00-04:00',
              check_out: '2026-10-16T10:00:00-04:00',
              reservation_status: { current: { category: 'accepted' } },
              guest: { first_name: 'James' },
            },
          ];
        },
      },
    });
    const result = await tool.execute(annaMsg, {
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      checkIn: '2026-10-16T16:00:00-04:00',
      checkOut: '2026-10-18T10:00:00-04:00',
      reservationId: 'anna-res',
      propertyName: '53 Pine St #2',
    });
    assert.equal(result.calendarChecked, true);
    assert.equal(result.reservationsChecked, true);
    assert.equal(result.allAvailable, false);
    assert.deepEqual(result.unavailableDates, ['2026-10-15']);
    assert.ok(result.blockingReservations?.some((b) => b.id === 'james-1night'));
  });

  it('StayExtensionTool dual-source free when calendar open and no conflicting reservation', async () => {
    const msg = 'Could we begin our stay one night earlier on 10/6?';
    const tool = new StayExtensionTool({
      hospitableClient: {
        async getPropertyCalendar() {
          return [{ date: '2026-10-06', status: { reason: 'AVAILABLE', available: true } }];
        },
        async getPropertyReservations() {
          return [
            {
              id: 'self',
              check_in: '2026-10-07',
              check_out: '2026-10-09',
              reservation_status: { current: { category: 'accepted' } },
            },
          ];
        },
      },
    });
    const result = await tool.execute(msg, {
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      checkIn: '2026-10-07',
      checkOut: '2026-10-09',
      reservationId: 'self',
      propertyName: '53 Pine St #2',
    });
    assert.equal(result.allAvailable, true);
    assert.match(result.suggestedResponseSnippet, /alteration request/i);
  });

  it('StayExtensionTool blocks when calendar free but reservation occupies night', async () => {
    const msg = 'Can we begin our stay one night earlier on Thursday, 10/15?';
    const tool = new StayExtensionTool({
      hospitableClient: {
        async getPropertyCalendar() {
          // Stale/wrong calendar saying free
          return [{ date: '2026-10-15', status: { reason: 'AVAILABLE', available: true } }];
        },
        async getPropertyReservations() {
          return [
            {
              id: 'blocker',
              check_in: '2026-10-15',
              check_out: '2026-10-16',
              reservation_status: { current: { category: 'accepted' } },
            },
            {
              id: 'self',
              check_in: '2026-10-16',
              check_out: '2026-10-18',
              reservation_status: { current: { category: 'accepted' } },
            },
          ];
        },
      },
    });
    const result = await tool.execute(msg, {
      listingId: 'x',
      checkIn: '2026-10-16',
      checkOut: '2026-10-18',
      reservationId: 'self',
      propertyName: '53 Pine St #2',
    });
    assert.equal(result.allAvailable, false);
    assert.deepEqual(result.unavailableDates, ['2026-10-15']);
    assert.doesNotMatch(result.suggestedResponseSnippet, /alteration request/i);
  });

  it('stay extension policy rewrites fabricated available when calendar says blocked', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyStayExtensionPolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse:
          'Good afternoon, Anna, I checked the calendar for 53 Pine St #2 and the night of 10/15 looks available. Please submit an alteration request.',
      },
      {
        guestName: 'Anna',
        guestDisplayName: 'Anna',
        stayExtensionInfo: {
          detected: true,
          extensionType: 'earlier_checkin',
          calendarChecked: true,
          allAvailable: false,
          unavailableDates: ['2026-10-15'],
          propertyName: '53 Pine St #2 · 1875 West End Victorian',
          suggestedResponseSnippet:
            'I checked the calendar for 53 Pine St #2 and unfortunately 2026-10-15 is not available — we already have another booking overlapping.',
        },
      },
      "begin our stay one night earlier on Thursday, 10/15?"
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'STAY_EXTENSION');
    assert.match(applied.proposedResponse, /not available|already booked/i);
    assert.doesNotMatch(applied.proposedResponse, /looks available/i);
    assert.doesNotMatch(applied.proposedResponse, /alteration request/i);
  });

  it('forces guest first name onto EARLY_CHECKIN drafts that omit it (Olivia flake)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyEarlyCheckinNamePolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse:
          'Good afternoon, check-in is at 4pm. If the unit is ready earlier we will message you.',
      },
      { guestName: 'Olivia' }
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /Olivia/);
    assert.match(applied.proposedResponse, /4pm/);
    const already = agent._applyEarlyCheckinNamePolicy(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: 'Hi Olivia, check-in is at 4pm.',
      },
      { guestName: 'Olivia' }
    );
    assert.equal(already.applied, false);
  });

  it('first-host welcome policy must NOT wipe stay-extension date-change drafts (Anna)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const annaMsg =
      "Hello! I'm wondering if it might be possible to begin our stay one night earlier — on Thursday, 10/15?";
    const applied = agent._applyFirstHostNewBookingWelcomePolicy(
      {
        typeOfMessageReceived: 'STAY_EXTENSION',
        proposedResponse:
          "Good afternoon, Anna, I checked the calendar for 53 Pine St #2 and unfortunately 10/15 is already booked, so we can't move the stay to cover that night.",
        shouldReply: true,
      },
      {
        reservationId: '6fc1f3fe-d33a-49d2-b380-b4a0e09f5065',
        guestName: 'Anna',
        stayExtensionInfo: {
          detected: true,
          calendarChecked: true,
          allAvailable: false,
        },
        conversationHistory: [],
      },
      annaMsg
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

  it('strips wrong formal time greeting from checkout thank-you (Nancy morning incident)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    // LLM (or stale booking-time clock) said Good evening at ~9:46 AM ET.
    const parsed = {
      typeOfMessageReceived: 'THANK_YOU_MESSAGE',
      proposedResponse:
        "Good evening, Nancy, You're welcome! Safe travels and hope you enjoyed the stay.",
    };
    const nancyCtx = {
      guestName: 'Nancy',
      guestDisplayName: 'Nancy',
      checkIn: '2026-08-06',
      checkOut: '2026-08-08',
      asOfDate: '2026-08-08',
      // Booking was in the evening — must NOT drive the reply greeting.
      bookingTimestamp: '2026-07-15T23:30:00Z',
    };
    const msg =
      'Thanks so much for hosting us! We checked out and left the keys. Safe travels yourself!';
    const applied = agent._applyPostCheckoutThankYouPolicy(parsed, nancyCtx, msg);
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /you're welcome/i);
    assert.doesNotMatch(applied.proposedResponse, /good evening/i);
    assert.doesNotMatch(applied.proposedResponse, /good morning/i);
    assert.doesNotMatch(applied.proposedResponse, /good afternoon/i);
    assert.match(applied.proposedResponse, /safe travels|enjoyed/i);
  });
});

describe('Eastern time-of-day greeting (Nancy incident)', () => {
  it('getTimeBasedGreeting is morning at 9:46 AM America/New_York', () => {
    // 2026-08-08 13:46 UTC = 9:46 AM EDT
    const info = getTimeBasedGreeting(new Date('2026-08-08T13:46:00.000Z'));
    assert.equal(info.hour, 9);
    assert.equal(info.greeting, 'Good morning');
  });

  it('getTimeBasedGreeting is afternoon at 2pm ET and evening at 6pm ET', () => {
    assert.equal(
      getTimeBasedGreeting(new Date('2026-08-08T18:00:00.000Z')).greeting,
      'Good afternoon'
    );
    assert.equal(
      getTimeBasedGreeting(new Date('2026-08-08T22:30:00.000Z')).greeting,
      'Good evening'
    );
  });

  it('resolveNowForGreeting ignores booking time and uses real now unless asOfDate set', () => {
    const withAsOf = resolveNowForGreeting({ asOfDate: '2026-08-08' });
    // Frozen eval clock is 18:00Z → 2pm EDT → afternoon
    assert.equal(getTimeBasedGreeting(withAsOf).greeting, 'Good afternoon');

    const liveMorning = resolveNowForGreeting({
      now: new Date('2026-08-08T13:46:00.000Z'),
      // bookingTimestamp must be ignored by resolveNowForGreeting (not even a param).
    });
    assert.equal(getTimeBasedGreeting(liveMorning).greeting, 'Good morning');
  });

  it('alignLeadingTimeGreeting rewrites Good evening → Good morning at 9:46 AM ET', () => {
    const morning = new Date('2026-08-08T13:46:00.000Z');
    const out = alignLeadingTimeGreeting(
      "Good evening, Nancy, You're welcome! Safe travels and hope you enjoyed the stay.",
      morning
    );
    assert.match(out, /^Good morning, Nancy,/i);
    assert.doesNotMatch(out, /good evening/i);
  });

  it('stripLeadingFormalTimeGreeting removes TOD prefix for thank-you drafts', () => {
    const out = stripLeadingFormalTimeGreeting(
      "Good evening, Nancy, You're welcome! Safe travels and hope you enjoyed the stay."
    );
    assert.match(out, /^You're welcome/i);
    assert.doesNotMatch(out, /good evening/i);
  });

  it('_sanitizeTimeOfDayGreeting strips pure thank-you formal greeting and aligns others', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const morningCtx = {
      asOfInstant: '2026-08-08T13:46:00.000Z',
      nowForGreeting: new Date('2026-08-08T13:46:00.000Z'),
    };
    const thanks = agent._sanitizeTimeOfDayGreeting(
      "Good evening, Nancy, You're welcome! Safe travels and hope you enjoyed the stay.",
      morningCtx,
      'THANK_YOU_MESSAGE'
    );
    assert.match(thanks, /^You're welcome/i);
    assert.doesNotMatch(thanks, /good (evening|morning|afternoon)/i);

    const ops = agent._sanitizeTimeOfDayGreeting(
      'Good evening, Henry, the lock box is on top.',
      morningCtx,
      'APT2_STREET_DOOR_LOCKOUT'
    );
    assert.match(ops, /^Good morning, Henry,/i);

    // Multi-intent (sofa-bed-linens-amy): keep greeting, align TOD — do not strip.
    const multi = agent._sanitizeTimeOfDayGreeting(
      "Good evening, Amy, You're welcome! Yes we provide sheets under the sofa.",
      morningCtx,
      ['THANK_YOU_MESSAGE', 'SLEEPING_ARRANGEMENTS']
    );
    assert.match(multi, /^Good morning, Amy,/i);
    assert.match(multi, /sheets under the sofa/i);
  });

  it('Apt2 lockout fallback uses live TOD not hardcoded Good evening', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' }
    });
    const apt2 = {
      guestName: 'Henry',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
      guestPhone: '6468040123',
      nowForGreeting: new Date('2026-08-08T13:46:00.000Z'),
    };
    const lockedOutMsg =
      'We accidentally locked the door not knowing that the front door locked and are unable to get into the Airbnb.';
    const applied = agent._applyApt2StreetDoorLockoutPolicy(
      { typeOfMessageReceived: 'APT2_STREET_DOOR_LOCKOUT', proposedResponse: 'none' },
      apt2,
      lockedOutMsg
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /^Good morning, Henry,/i);
    assert.doesNotMatch(applied.proposedResponse, /good evening/i);
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

  it('HARDENING: recent host activity does not suppress THANKS + new shuttle/rainy-day questions (Amber)', async () => {
    const amber =
      "I saw the guidebook, thank you! We ended up having to drive my husband to the airport at 4:30am because we were unprepared for a taxi and Uber dead zone at that time lol. He'll be back at 1am early Wednesday before we check out. Is there a shuttle your recommend so I'm not dragging the kids out of bed again?\n\nAlso keeping my girls occupied in the city on a rainy day? Most of my big plans were outdoors.";
    const draft =
      "You're welcome, Amber! For the 1am airport run, the Portland Jetport shared-ride shuttle works well. For rainy days with the girls, the Children's Museum of Maine or Portland Public Library story times are great indoor options.";
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: ['THANKS', 'TRANSPORT_QUESTION', 'ACTIVITIES_QUESTION'],
            proposedResponse: draft,
            shouldReply: true,
            confidence: 0.9,
          }),
      },
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => [
          {
            sender_type: 'host',
            body: 'Good morning Amber, I hope that you have settled in after your travel and that you are enjoying your stay. Let me know if you need anything!',
            created_at: fiveMinAgo,
          },
          { sender_type: 'guest', body: amber, created_at: new Date().toISOString() },
        ],
      }),
      requireLiveConversationHistory: false,
    });

    const result = await agent.handleMessage(amber, {
      guestName: 'Amber',
      conversation_id: '5d52d6e7-68d0-4e2b-91e9-4bbf6af119df',
      reservationId: '48da4e7d-4aa9-43bf-8fc7-dd0ed7ea6a16',
      listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
      propertyName: 'Cozy, Central 2 Bd Apt, Parking',
      checkIn: '2026-08-16T16:00:00-04:00',
      checkOut: '2026-08-19T10:00:00-04:00',
      sender_type: 'guest',
    });

    assert.equal(result.shouldReply, true);
    assert.equal(result.suppressedDueToRecentHost, undefined);
    assert.match(result.proposedResponse, /welcome, amber/i);
    assert.match(result.proposedResponse, /shuttle|taxi|museum|library|indoor/i);
  });
});

describe('Smoke-alarm all-clear (Carlos, no LLM)', () => {
  const carlosMsg =
    'Everything is good, we had something boiling. Richard came up to make sure everything was okay.';
  const smokeNotice = [
    'Hi Carlos,',
    '',
    'The smoke detector just went off in Pine Apt #2. Please check now.',
    '',
    'If it is a real fire: leave and call 911. If cooking or steam: open windows. Reply if you need help.',
    '',
    'Jerome',
    '',
  ].join('\n');
  const carlosCtx = {
    guestName: 'Carlos',
    listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
    propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
    checkIn: '2026-08-24T16:00:00-04:00',
    checkOut: '2026-08-28T10:00:00-04:00',
    asOfDate: '2026-08-26',
    conversationHistory: [
      { sender_type: 'host', body: smokeNotice },
      { sender_type: 'guest', body: carlosMsg },
    ],
  };

  it('forces thanks + glad you are all safe even when the LLM withholds', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applySmokeAlarmAllClearPolicy(
      {
        typeOfMessageReceived: 'OTHER_MESSAGE',
        proposedResponse: 'none',
        shouldReply: false,
      },
      carlosCtx,
      carlosMsg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.typeOfMessageReceived, 'FYI_STATEMENT');
    assert.match(applied.proposedResponse, /Thanks for letting us know everything is okay, Carlos/i);
    assert.match(applied.proposedResponse, /Glad you are all safe/i);
    assert.match(applied.proposedResponse, /thanks to Richard for checking in/i);
    assert.doesNotMatch(applied.proposedResponse, /call 911/i);
  });

  it('does not fire on unrelated all-good messages', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applySmokeAlarmAllClearPolicy(
      { typeOfMessageReceived: 'OTHER_MESSAGE', proposedResponse: 'none' },
      { guestName: 'Carlos', conversationHistory: [] },
      'Everything is good, thanks!'
    );
    assert.equal(applied.applied, false);
  });

  it('does not send a second all-clear if we already thanked them', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applySmokeAlarmAllClearPolicy(
      { typeOfMessageReceived: 'FYI_STATEMENT', proposedResponse: 'none' },
      {
        ...carlosCtx,
        conversationHistory: [
          { sender_type: 'host', body: smokeNotice },
          { sender_type: 'guest', body: carlosMsg },
          {
            sender_type: 'host',
            body: 'Thanks for letting us know everything is okay, Carlos! Glad you are all safe — and thanks to Richard for checking in.',
          },
        ],
      },
      carlosMsg
    );
    assert.equal(applied.applied, false);
  });

  it('HARDENING: recent host smoke notice does not suppress the all-clear ack', async () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'OTHER_MESSAGE',
            proposedResponse: 'none',
            shouldReply: false,
            confidence: 0.4,
          }),
      },
      hospitableClient: mockHospitableClient({
        getReservationMessages: async () => [
          { sender_type: 'host', body: smokeNotice, created_at: twoMinAgo },
          { sender_type: 'guest', body: carlosMsg, created_at: new Date().toISOString() },
        ],
      }),
      requireLiveConversationHistory: false,
    });

    const result = await agent.handleMessage(carlosMsg, {
      ...carlosCtx,
      conversation_id: '5b54f75a-d12f-422f-8e53-047e152cae37',
      reservationId: '660075cd-d520-4de9-bece-9860625728d5',
      sender_type: 'guest',
    });

    assert.equal(result.shouldReply, true);
    assert.ok(result.suppressedDueToRecentHost !== true);
    assert.equal(result.typeOfMessageReceived, 'FYI_STATEMENT');
    assert.match(result.proposedResponse, /Thanks for letting us know everything is okay, Carlos/i);
    assert.match(result.proposedResponse, /Glad you are all safe/i);
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

  it('does not treat early-departure "cleaning process" logistics as a cleaning complaint (Olivia incident)', async () => {
    const { CleaningIssueTool } = await import('../src/tools/CleaningIssueTool.js');
    const tool = new CleaningIssueTool();
    const msg =
      "Hi Jerome - I'm flying into Portland tomorrow morning and landing around 9AM. Is there any opportunity for an early check in? If so, please let me know what time we'd be able to arrive. We're also planning to leave early on Sunday (by/before 9AM), so I will message you when we depart in case you want to start the cleaning process early.";
    const result = await tool.execute(msg, {
      guestName: 'Olivia',
      reservationId: '22471edf-6221-4900-9609-88a925499e9a',
      propertyName: 'Cozy, Central 2 Bd Apt, Parking',
    });
    assert.equal(result.detected, false, 'early-departure courtesy mentioning cleaning process must not escalate');
  });

  it('still detects real cleaning complaints that use the word cleaning', async () => {
    const { CleaningIssueTool } = await import('../src/tools/CleaningIssueTool.js');
    const tool = new CleaningIssueTool();
    const result = await tool.execute(
      'The cleaning was poor — the bathroom was dirty when we arrived.',
      { guestName: 'Test' }
    );
    assert.equal(result.detected, true);
  });

  it('HeatPumpTool does not treat "opportunity" early-check-in as HVAC (Olivia unit substring)', async () => {
    const { HeatPumpTool } = await import('../src/tools/hvac/HeatPumpTool.js');
    const tool = new HeatPumpTool(); // no kumo client — relevance only
    const msg =
      "Hi Jerome - I'm flying into Portland tomorrow morning and landing around 9AM. Is there any opportunity for an early check in? If so, please let me know what time we'd be able to arrive. We're also planning to leave early on Sunday (by/before 9AM), so I will message you when we depart in case you want to start the cleaning process early.";
    const result = await tool.execute(msg, {
      listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
      guestName: 'Olivia',
    });
    assert.equal(result.guestMessageRelevant, false, '"opportunity" must not match keyword unit');
    assert.equal(result.actionTaken, null);
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
      { detected: true, matchedPhrase: 'no sheets', strength: 'strong', blocksAutoReply: true },
      amyMsg
    );
    assert.equal(skipped.applied, false);

    const escalated = agent._applyCleaningIssueEscalationPolicy(
      { typeOfMessageReceived: 'OTHER_MESSAGE', proposedResponse: 'Sorry about that.' },
      { detected: true, matchedPhrase: 'hair in the shower', strength: 'strong', blocksAutoReply: true },
      'There was hair in the shower when we arrived.'
    );
    assert.equal(escalated.applied, true);
    assert.equal(escalated.shouldReply, false);
    assert.equal(escalated.proposedResponse, 'none');
    assert.equal(escalated.escalated, true);
  });

  it('HARDENING: logistics cleaning never blocks EARLY_CHECKIN draft (Olivia class)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const oliviaMsg =
      "Hi Jerome - I'm flying into Portland tomorrow morning and landing around 9AM. Is there any opportunity for an early check in? If so, please let me know what time we'd be able to arrive. We're also planning to leave early on Sunday (by/before 9AM), so I will message you when we depart in case you want to start the cleaning process early.";
    const draft =
      "Good evening, Olivia, we can't guarantee early check-in since the unit needs preparation time, but if cleaning finishes before 4pm we'll message you right away. Thanks for the heads-up on your early Sunday departure—we'll note that.";

    // Even if a buggy tool returned detected:true with bare "cleaning", policy must not wipe.
    const policy = agent._applyCleaningIssueEscalationPolicy(
      { typeOfMessageReceived: 'EARLY_CHECKIN', proposedResponse: draft, shouldReply: true, confidence: 1 },
      { detected: true, matchedPhrase: 'cleaning', strength: 'weak', blocksAutoReply: false },
      oliviaMsg
    );
    assert.equal(policy.applied, false);
    assert.equal(policy.alertOnly, true);

    // Logistics language in the guest message wins even if a buggy tool claimed "dirty".
    const policy2 = agent._applyCleaningIssueEscalationPolicy(
      { typeOfMessageReceived: 'EARLY_CHECKIN', proposedResponse: draft, shouldReply: true },
      { detected: true, matchedPhrase: 'dirty', strength: 'strong', blocksAutoReply: true },
      oliviaMsg
    );
    assert.equal(policy2.applied, false);

    // Real strong in-stay cleaning complaint (no logistics) still escalates.
    const realComplaint = agent._applyCleaningIssueEscalationPolicy(
      { typeOfMessageReceived: 'OTHER_MESSAGE', proposedResponse: 'Sorry about the mess.', shouldReply: true },
      { detected: true, matchedPhrase: 'dirty', strength: 'strong', blocksAutoReply: true },
      'The bathroom was dirty when we arrived.'
    );
    assert.equal(realComplaint.applied, true);
    assert.equal(realComplaint.shouldReply, false);

    // Safety net restores wiped draft after judge APPROVE
    const restored = agent._applyApprovedDraftSafetyNet(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: 'none',
        shouldReply: false,
        escalated: true,
        confidence: 1,
      },
      {
        preCleanDraft: draft,
        preCleanShouldReply: true,
        judgeVerdict: 'APPROVE',
        reflectionDecision: 'APPROVED',
      }
    );
    assert.equal(restored.applied, true);
    assert.equal(restored.shouldReply, true);
    assert.equal(restored.proposedResponse, draft);
    assert.equal(restored.escalated, false);

    // Safety net must NOT restore after judge REJECT
    const notRestored = agent._applyApprovedDraftSafetyNet(
      {
        typeOfMessageReceived: 'EARLY_CHECKIN',
        proposedResponse: 'none',
        shouldReply: false,
        escalated: true,
        judgeForcedReject: true,
      },
      {
        preCleanDraft: draft,
        preCleanShouldReply: true,
        judgeVerdict: 'REJECT',
      }
    );
    assert.equal(notRestored.applied, false);
  });

  it('HARDENING: HeatPumpTool short-circuits with no action when not HVAC-relevant', async () => {
    const { HeatPumpTool } = await import('../src/tools/hvac/HeatPumpTool.js');
    let fetchCalled = false;
    const fakeKumo = {
      getStatusForListing: async () => {
        fetchCalled = true;
        return { summary: { modes: ['heat'] }, units: [] };
      },
      ensureConsistentForComplaint: async () => {
        fetchCalled = true;
        return { fixed: true, recommendedMode: 'auto', recommendedTempF: 65 };
      },
    };
    const tool = new HeatPumpTool({ kumoClient: fakeKumo });
    const msg =
      "Is there any opportunity for an early check in? We'll leave early so you can start the cleaning process early.";
    const result = await tool.execute(msg, {
      listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
      guestName: 'Olivia',
    });
    assert.equal(result.guestMessageRelevant, false);
    assert.equal(result.actionTaken, null);
    assert.equal(result.skippedReason, 'not_hvac_relevant');
    assert.equal(fetchCalled, false, 'must not call Kumo when not HVAC-relevant');
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

describe('Known stay dates policy (Dashiell — no LLM)', () => {
  it('strips "let me know the exact dates" when checkIn/checkOut already known', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const badDraft =
      "Good evening, Dashiell, thanks for reaching out! We'd love to host you and your family for a short getaway. " +
      "Since you mentioned your well-behaved dog, the $30 pet fee is already included for one pet, and we just ask that pets stay off the beds and sofa. " +
      "Let me know the exact dates you're thinking of and I'll check availability right away. " +
      "Looking forward to potentially hosting you in Portland.\n\nJerome & Ruby";

    const applied = agent._applyKnownStayDatesPolicy(
      {
        typeOfMessageReceived: 'NEW_INQUIRY_WELCOME',
        proposedResponse: badDraft,
        shouldReply: true,
        confidence: 0.9,
      },
      {
        guestName: 'Dashiell',
        checkIn: '2026-08-31T16:00:00-04:00',
        checkOut: '2026-09-02T10:00:00-04:00',
        reservationId: '0e101acf-d179-47f5-8ebd-059638bdde37',
        isInquiry: false,
        hasPets: true,
        petCount: 1,
      },
      'Hi we have a well behaved dog and would love a short getaway'
    );

    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'NEW_RESERVATION_WELCOME');
    assert.ok(applied.proposedResponse.includes('$30 pet fee'));
    assert.ok(applied.proposedResponse.includes('beds and sofa'));
    assert.doesNotMatch(applied.proposedResponse, /exact dates you'?re thinking/i);
    assert.doesNotMatch(applied.proposedResponse, /let me know (the |your )?(exact )?dates/i);
    assert.match(applied.proposedResponse, /I see your stay is/i);
    assert.match(applied.proposedResponse, /August|2026/i);
  });

  it('does not rewrite when context has no stay dates', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const draft = "Let me know the exact dates you're thinking of and I'll check availability right away.";
    const applied = agent._applyKnownStayDatesPolicy(
      { typeOfMessageReceived: 'NEW_INQUIRY_WELCOME', proposedResponse: draft },
      { guestName: 'Sam', isInquiry: true },
      'Do you have availability?'
    );
    assert.equal(applied.applied, false);
  });

  it('injects critical known-dates line into user prompt', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const prompt = agent._buildUserPrompt('Hi with our dog', {
      guestName: 'Dashiell',
      checkIn: '2026-08-31T16:00:00-04:00',
      checkOut: '2026-09-02T10:00:00-04:00',
      reservationId: '0e101acf-d179-47f5-8ebd-059638bdde37',
      isInquiry: false,
      hasPets: true,
      petCount: 1,
    });
    assert.match(prompt, /CRITICAL STAY DATES ALREADY KNOWN/);
    assert.match(prompt, /NEVER ask the guest for dates/i);
  });
});

describe('Not-check-in-day access (Michael, no LLM)', () => {
  const michaelCtx = {
    guestName: 'Michael',
    listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
    propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
    checkIn: '2026-08-21T16:00:00-04:00',
    checkOut: '2026-08-24T10:00:00-04:00',
    asOfDate: '2026-08-20',
    asOfInstant: '2026-08-20T18:04:00-04:00',
  };
  const cantGetIn =
    "The door code is not working, we can't get in. Can you please confirm what our apt # is?";
  const aptAsk = 'Hello! Can you please confirm what our apt # is?';

  it('detects Michael apt-number and cannot-get-in messages the day before check-in', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._isBeforeCheckInDay(michaelCtx), true);
    assert.equal(agent._looksLikePreCheckinAccessAttempt(aptAsk), true);
    assert.equal(agent._looksLikePreCheckinAccessAttempt(cantGetIn), true);
    assert.equal(agent._daysUntilCheckIn(michaelCtx), 1);
  });

  it('rewrites to not-check-in-day (does not treat as lockout)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyNotCheckinDayAccessPolicy(
      { typeOfMessageReceived: 'DOOR_CODE_ISSUE', proposedResponse: 'Try backup code 0000' },
      michaelCtx,
      cantGetIn
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'NOT_CHECKIN_DAY_ACCESS');
    assert.equal(applied.shouldReply, true);
    assert.match(applied.proposedResponse, /not your check-in day/i);
    assert.match(applied.proposedResponse, /tomorrow/i);
    assert.doesNotMatch(applied.proposedResponse, /August 21/);
    assert.match(applied.proposedResponse, /4pm/i);
    assert.match(applied.proposedResponse, /door code is not on the lock/i);
    assert.match(applied.proposedResponse, /Apt 2/);
    assert.doesNotMatch(applied.proposedResponse, /backup/i);
    assert.doesNotMatch(applied.proposedResponse, /lock\s*box/i);

    const lockout = agent._applyApt2StreetDoorLockoutPolicy({}, michaelCtx, cantGetIn);
    assert.equal(lockout.applied, false);
  });

  it('does not apply on check-in day', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyNotCheckinDayAccessPolicy(
      {},
      { ...michaelCtx, asOfDate: '2026-08-21' },
      cantGetIn
    );
    assert.equal(applied.applied, false);
  });

  it('says on Friday when check-in is several days out', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyNotCheckinDayAccessPolicy(
      {},
      { ...michaelCtx, asOfDate: '2026-08-17' },
      cantGetIn
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /on Friday/i);
    assert.doesNotMatch(applied.proposedResponse, /tomorrow/i);
    assert.doesNotMatch(applied.proposedResponse, /August 21/);
  });
});

describe('In-stay crib location (Michael Apt 2, no LLM)', () => {
  const michaelCtx = {
    guestName: 'Michael',
    listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
    propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
    checkIn: '2026-08-21T16:00:00-04:00',
    checkOut: '2026-08-24T10:00:00-04:00',
    asOfDate: '2026-08-21',
    asOfInstant: '2026-08-21T16:30:00-04:00',
  };
  const whereIsIt =
    'Just entered the unit. Can you please remind me where the crib is located?';
  const kyrieAvailability =
    'Would it be possible to have a crib available? We see that one is available upon request.';

  it('detects current-guest crib location asks on check-in day', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._isCurrentStay(michaelCtx), true);
    assert.equal(agent._looksLikeInStayCribLocationAsk(whereIsIt, michaelCtx), true);
    assert.equal(agent._looksLikeInStayCribLocationAsk(kyrieAvailability, michaelCtx), false);
  });

  it('rewrites availability copy to Apt 2 closet location + cannot-find follow-up', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyInStayCribLocationPolicy(
      {
        typeOfMessageReceived: 'PACK_AND_PLAY_BRAND',
        proposedResponse:
          'Michael, the Graco Pack and Play is already set up and ready in the unit for you.',
      },
      michaelCtx,
      whereIsIt
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'PACK_AND_PLAY_BRAND');
    assert.equal(applied.shouldReply, true);
    assert.match(applied.proposedResponse, /closet of the smaller bedroom/i);
    assert.match(applied.proposedResponse, /let us know if you cannot find/i);
    assert.match(applied.proposedResponse, /^Michael,/);
    assert.doesNotMatch(applied.proposedResponse, /already set up/i);
  });

  it('does not apply to future-guest crib availability asks (Kyrie)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const kyrieCtx = {
      guestName: 'Kyrie',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      propertyName: 'Sunny Apt 2',
      checkIn: '2026-07-10',
      checkOut: '2026-07-13',
      asOfDate: '2026-06-20',
    };
    const applied = agent._applyInStayCribLocationPolicy(
      {
        typeOfMessageReceived: 'PACK_AND_PLAY_BRAND',
        proposedResponse:
          "Good afternoon Kyrie, yes we use the Graco Pack and Play and it's already set up and ready in the unit for you.",
      },
      kyrieCtx,
      kyrieAvailability
    );
    assert.equal(applied.applied, false);
    assert.equal(agent._looksLikeInStayCribLocationAsk(kyrieAvailability, kyrieCtx), false);
  });

  it('still locates from "just entered" language even if stay dates are missing', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyInStayCribLocationPolicy(
      { proposedResponse: 'none' },
      { guestName: 'Michael', listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d' },
      whereIsIt
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /closet of the smaller bedroom/i);
  });

  it('does not invent the Apt 2 closet for other units', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyInStayCribLocationPolicy(
      {},
      {
        guestName: 'Sam',
        listingId: 'c899481f-2e5b-402d-80c4-3167fd824d96',
        propertyName: 'Downtown Studio 1B',
        checkIn: '2026-08-21',
        checkOut: '2026-08-24',
        asOfDate: '2026-08-21',
      },
      whereIsIt
    );
    assert.equal(applied.applied, true);
    assert.doesNotMatch(applied.proposedResponse, /closet of the smaller bedroom/i);
    assert.match(applied.proposedResponse, /already be in the unit/i);
    assert.match(applied.proposedResponse, /let us know if you cannot find/i);
  });
});

describe('In-stay see-you-soon strip (Michael, no LLM)', () => {
  const michaelInUnit = {
    guestName: 'Michael',
    listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
    propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
    checkIn: '2026-08-21T16:00:00-04:00',
    checkOut: '2026-08-24T10:00:00-04:00',
    asOfDate: '2026-08-21',
    guestArrived: true,
    guestArrivedAt: '2026-08-21T20:12:00.000Z',
  };

  it('strips see you soon when the guest is already in the unit', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._alreadyInUnit(michaelInUnit, 'Thanks'), true);
    const applied = agent._applyInStaySeeYouSoonPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Michael! See you soon.",
      },
      michaelInUnit,
      'Thanks'
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /you're welcome, michael/i);
    assert.doesNotMatch(applied.proposedResponse, /see you soon/i);
  });

  it('does not strip Taylor arriving-in-an-hour see you', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const taylor = {
      guestName: 'Taylor',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      checkIn: '2026-06-04',
      checkOut: '2026-06-06',
      asOfDate: '2026-06-04',
      guestArrived: false,
    };
    const msg = 'Ahh that’s perfect!! We will be arriving in about an hour! Thank you';
    assert.equal(agent._alreadyInUnit(taylor, msg), false);
    const applied = agent._applyInStaySeeYouSoonPolicy(
      {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Taylor! Perfect — we'll see you in about an hour.",
      },
      taylor,
      msg
    );
    assert.equal(applied.applied, false);
  });
});

describe('Pre-send second reasoning round prompt (no LLM)', () => {
  it('tells first-pass and judge that a new guest message just appeared', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const ctx = {
      guestName: 'Michael',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      _preSendReprocessed: true,
      preSendOriginalGuestMessage: 'All set',
      preSendNewerGuestMessages: ['Richard popped in and helped', 'Thanks'],
      preSendStaleDraft: "You're welcome, Michael! See you soon.",
    };
    const prompt = agent._buildUserPrompt('Thanks', ctx);
    assert.match(prompt, /CRITICAL PRE-SEND UPDATE/);
    assert.match(prompt, /second reasoning round/i);
    assert.match(prompt, /All set/);
    assert.match(prompt, /Richard popped in and helped/);
    assert.match(prompt, /see you soon/i);
  });
});

describe('Post-stay access (day after checkout, no LLM)', () => {
  const alexCtx = {
    guestName: 'Alex',
    listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
    propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
    checkIn: '2026-08-21T16:00:00-04:00',
    checkOut: '2026-08-24T10:00:00-04:00',
    asOfDate: '2026-08-25',
    asOfInstant: '2026-08-25T18:04:00-04:00',
  };
  const cantGetIn =
    "The door code is not working, we can't get in. Can you please confirm what our apt # is?";

  it('detects cannot-get-in the day after checkout', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    assert.equal(agent._isAfterCheckoutDay(alexCtx), true);
    assert.equal(agent._isBeforeCheckInDay(alexCtx), false);
    assert.equal(agent._daysSinceCheckout(alexCtx), 1);
    assert.equal(agent._looksLikePreCheckinAccessAttempt(cantGetIn), true);
  });

  it('rewrites to post-stay access (does not treat as lockout)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyPostStayAccessPolicy(
      { typeOfMessageReceived: 'DOOR_CODE_ISSUE', proposedResponse: 'Try backup code 0000' },
      alexCtx,
      cantGetIn
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'POST_STAY_ACCESS');
    assert.equal(applied.shouldReply, true);
    assert.match(applied.proposedResponse, /I'?m sorry/i);
    assert.match(applied.proposedResponse, /your stay was yesterday/i);
    assert.doesNotMatch(applied.proposedResponse, /August 24/);
    assert.match(applied.proposedResponse, /Checkout was at 10am/i);
    assert.match(applied.proposedResponse, /door code is already off the lock/i);
    assert.match(applied.proposedResponse, /new guest/i);
    assert.doesNotMatch(applied.proposedResponse, /backup/i);
    assert.doesNotMatch(applied.proposedResponse, /lock\s*box/i);

    const lockout = agent._applyApt2StreetDoorLockoutPolicy({}, alexCtx, cantGetIn);
    assert.equal(lockout.applied, false);
  });

  it('does not apply on checkout day or in-stay', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const onCheckout = agent._applyPostStayAccessPolicy(
      {},
      { ...alexCtx, asOfDate: '2026-08-24' },
      cantGetIn
    );
    assert.equal(onCheckout.applied, false);
    const inStay = agent._applyPostStayAccessPolicy(
      {},
      { ...alexCtx, asOfDate: '2026-08-22' },
      cantGetIn
    );
    assert.equal(inStay.applied, false);
  });

  it('says on Monday when checkout was several days ago', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyPostStayAccessPolicy(
      {},
      { ...alexCtx, asOfDate: '2026-08-27' },
      cantGetIn
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse, /your stay ended on Monday/i);
    assert.doesNotMatch(applied.proposedResponse, /yesterday/i);
    assert.doesNotMatch(applied.proposedResponse, /August 24/);
  });

  it('Henry-style lockout after checkout becomes post-stay, not street lockbox', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const lockedOutMsg =
      'We accidentally locked the door not knowing that the front door locked and are unable to get into the Airbnb.';
    const ctx = {
      guestName: 'Henry',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
      guestPhone: '6468040123',
      checkIn: '2026-07-24',
      checkOut: '2026-07-26',
      asOfDate: '2026-07-27',
    };
    const stayWindow = agent._applyStayWindowAccessPolicy({}, ctx, lockedOutMsg);
    assert.equal(stayWindow.applied, true);
    assert.equal(stayWindow.typeOfMessageReceived, 'POST_STAY_ACCESS');
    assert.match(stayWindow.proposedResponse, /yesterday/i);
    assert.doesNotMatch(stayWindow.proposedResponse, /lock\s*box/i);
    const lockout = agent._applyApt2StreetDoorLockoutPolicy({}, ctx, lockedOutMsg);
    assert.equal(lockout.applied, false);
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

    const prompt = await modularAgent.loadPrompt({
      guestMessage: 'I need to cancel my reservation due to an emergency.',
    });
    assert.ok(prompt.includes('Category Rules'), 'Modular prompt should include category rules');
    assert.ok(prompt.includes('cancellation') || prompt.includes('Cancellation'), 'Should include cancellation category');
    assert.ok(
      !prompt.includes('# Conversation Judge (Anti-Repetition'),
      'First-pass prompt must not include conversation-judge.md'
    );
    assert.ok(
      !prompt.includes('# Reflection / Critique Pass'),
      'First-pass prompt must not include reflection.md'
    );
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

  it('Cassidy leave-the-car after checkout: never allows own spot (mock Hospitable, live Grok)', async () => {
    const apt2 = '114663c5-0709-4eff-a868-fa9ebd6ed42d';
    const apt1b = 'c899481f-2e5b-402d-80c4-3167fd824d96';
    const apt3 = '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd';
    const occupiedByListing = { [apt1b]: false, [apt2]: false, [apt3]: true };
    const mockHospitable = {
      async hasGuestsOnDate(listingId) {
        return !!occupiedByListing[listingId];
      },
      async getConversationMessages() { return []; },
      async getReservationMessages() { return []; },
      async getInquiryMessages() { return []; },
      async getThreadMessages() { return []; },
    };
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      hospitableClient: mockHospitable,
      requireLiveConversationHistory: false,
    });
    const msg =
      'Hi! We were also wondering for tomorrow if we could leave the car in the parking spot during the day as we walk around? And what would be the latest check out time?';

    // Exact production miss: Sunday 8/16 5:56pm ET, checkout Monday 8/17.
    // 1B is vacant but it is before 8pm — exception must NOT fire.
    const refused = await agent.processMessage(msg, {
      guestName: 'Cassidy',
      listingId: apt2,
      propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
      checkIn: '2026-08-16',
      checkOut: '2026-08-17',
      asOfInstant: '2026-08-16T17:56:00-04:00',
      nowForGreeting: new Date('2026-08-16T17:56:00-04:00'),
    });

    assert.equal(refused.shouldReply, true, 'Must auto-reply to Cassidy parking + checkout ask');
    assert.ok(refused.proposedResponse && refused.proposedResponse !== 'none');
    assert.match(refused.proposedResponse, /10\s*(:00)?\s*am/i);
    assert.match(refused.proposedResponse, /cleaning team/i);
    assert.match(refused.proposedResponse, /clean the unit/i);
    assert.match(refused.proposedResponse, /next guests/i);
    assert.doesNotMatch(refused.proposedResponse, /yes you can leave the car/i);
    assert.doesNotMatch(refused.proposedResponse, /you can leave the car in your/i);
    assert.doesNotMatch(refused.proposedResponse, /car in your dedicated spot/i);
    assert.doesNotMatch(refused.proposedResponse, /1B parking spot/i);
    assert.equal(refused.postCheckoutParkingInfo?.detected, true);
    assert.equal(refused.postCheckoutParkingInfo?.exceptionEligible, false);

    // After 8pm ET the evening before + 1B vacant Monday night → Ruby path.
    const offered = await agent.processMessage(msg, {
      guestName: 'Cassidy',
      listingId: apt2,
      propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
      checkIn: '2026-08-16',
      checkOut: '2026-08-17',
      asOfInstant: '2026-08-16T20:30:00-04:00',
      nowForGreeting: new Date('2026-08-16T20:30:00-04:00'),
    });

    assert.equal(offered.shouldReply, true);
    assert.match(offered.proposedResponse, /10\s*(:00)?\s*am/i);
    assert.match(offered.proposedResponse, /1B parking spot/i);
    assert.match(offered.proposedResponse, /1\s*(:00)?\s*pm/i);
    assert.match(offered.proposedResponse, /current spot/i);
    assert.match(offered.proposedResponse, /cleaning team/i);
    assert.match(offered.proposedResponse, /clean the unit/i);
    assert.doesNotMatch(offered.proposedResponse, /yes you can leave the car/i);
    assert.doesNotMatch(offered.proposedResponse, /leave the car in your dedicated/i);
    assert.equal(offered.postCheckoutParkingInfo?.exceptionEligible, true);
    assert.equal(offered.postCheckoutParkingInfo?.vacantSibling?.shortName, '1B');
  });

  it('Michael day-before cannot-get-in: tell them it is not check-in day (mock Hospitable, live Grok)', async () => {
    const mockHospitable = {
      async hasGuestsOnDate() { return false; },
      async getConversationMessages() { return []; },
      async getReservationMessages() { return []; },
      async getInquiryMessages() { return []; },
      async getThreadMessages() { return []; },
    };
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      hospitableClient: mockHospitable,
      requireLiveConversationHistory: false,
    });
    const msg =
      "The door code is not working, we can't get in. Can you please confirm what our apt # is?";
    const result = await agent.processMessage(msg, {
      guestName: 'Michael',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
      checkIn: '2026-08-21T16:00:00-04:00',
      checkOut: '2026-08-24T10:00:00-04:00',
      asOfDate: '2026-08-20',
      asOfInstant: '2026-08-20T18:04:00-04:00',
      nowForGreeting: new Date('2026-08-20T18:04:00-04:00'),
      reservationId: 'test-michael-not-sent',
      conversation_id: 'test-michael-not-sent',
    });

    assert.equal(result.shouldReply, true, 'Must auto-reply that it is not check-in day');
    assert.equal(result.typeOfMessageReceived, 'NOT_CHECKIN_DAY_ACCESS');
    assert.ok(result.proposedResponse && result.proposedResponse !== 'none');
    assert.match(result.proposedResponse, /not your check-in day/i);
    assert.match(result.proposedResponse, /tomorrow/i);
    assert.doesNotMatch(result.proposedResponse, /August 21/);
    assert.match(result.proposedResponse, /4pm/i);
    assert.match(result.proposedResponse, /door code is not on the lock/i);
    assert.doesNotMatch(result.proposedResponse, /backup/i);
    assert.doesNotMatch(result.proposedResponse, /lock\s*box/i);
    assert.doesNotMatch(result.proposedResponse, /you'?re staying in Sunny Apt 2/i);
    console.log('[michael-not-checkin-day] proposedResponse:\n', result.proposedResponse);
  });

  it('day-after-checkout cannot-get-in: sorry, stay was yesterday (mock Hospitable, live Grok)', async () => {
    const mockHospitable = {
      async hasGuestsOnDate() { return false; },
      async getConversationMessages() { return []; },
      async getReservationMessages() { return []; },
      async getInquiryMessages() { return []; },
      async getThreadMessages() { return []; },
    };
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      hospitableClient: mockHospitable,
      requireLiveConversationHistory: false,
    });
    const msg =
      "The door code is not working, we can't get in. Can you please confirm what our apt # is?";
    const result = await agent.processMessage(msg, {
      guestName: 'Alex',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
      checkIn: '2026-08-21T16:00:00-04:00',
      checkOut: '2026-08-24T10:00:00-04:00',
      asOfDate: '2026-08-25',
      asOfInstant: '2026-08-25T18:04:00-04:00',
      nowForGreeting: new Date('2026-08-25T18:04:00-04:00'),
      reservationId: 'test-post-stay-not-sent',
      conversation_id: 'test-post-stay-not-sent',
    });

    assert.equal(result.shouldReply, true, 'Must auto-reply that the stay already ended');
    assert.equal(result.typeOfMessageReceived, 'POST_STAY_ACCESS');
    assert.ok(result.proposedResponse && result.proposedResponse !== 'none');
    assert.match(result.proposedResponse, /I'?m sorry/i);
    assert.match(result.proposedResponse, /yesterday/i);
    assert.doesNotMatch(result.proposedResponse, /August 24/);
    assert.match(result.proposedResponse, /Checkout was at 10am/i);
    assert.match(result.proposedResponse, /door code is already off the lock/i);
    assert.match(result.proposedResponse, /new guest/i);
    assert.doesNotMatch(result.proposedResponse, /backup/i);
    assert.doesNotMatch(result.proposedResponse, /lock\s*box/i);
    console.log('[post-stay-late-access] proposedResponse:\n', result.proposedResponse);
  });

  it('Michael in-stay crib location: closet of smaller bedroom (mock Hospitable, live Grok, PIN arrived)', async () => {
    const mockHospitable = {
      async hasGuestsOnDate() { return true; },
      async getConversationMessages() { return []; },
      async getReservationMessages() { return []; },
      async getInquiryMessages() { return []; },
      async getThreadMessages() { return []; },
    };
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      hospitableClient: mockHospitable,
      requireLiveConversationHistory: false,
      guestCheckInsLookup: async () => ({
        guestArrived: true,
        checkedInAt: '2026-08-21T20:12:00.000Z',
        lockName: 'Apt 2 parking-side',
        checkInKey: '20150380_2026-08-21',
      }),
    });
    const msg = 'Just entered the unit. Can you please remind me where the crib is located?';
    const result = await agent.processMessage(msg, {
      guestName: 'Michael',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
      checkIn: '2026-08-21T16:00:00-04:00',
      checkOut: '2026-08-24T10:00:00-04:00',
      asOfDate: '2026-08-21',
      asOfInstant: '2026-08-21T16:30:00-04:00',
      nowForGreeting: new Date('2026-08-21T16:30:00-04:00'),
      reservationId: 'test-michael-crib-not-sent',
      conversation_id: 'test-michael-crib-not-sent',
      conversationHistory: [
        {
          sender_type: 'guest',
          body: 'Hello! Can you please confirm what our apt # is?',
        },
        {
          sender_type: 'host',
          body: 'Good afternoon, Michael, today is not your check-in day — check-in is tomorrow at 4pm.',
        },
      ],
    });

    assert.equal(result.shouldReply, true, 'Must auto-reply with crib location');
    assert.equal(result.typeOfMessageReceived, 'PACK_AND_PLAY_BRAND');
    assert.ok(result.proposedResponse && result.proposedResponse !== 'none');
    assert.match(result.proposedResponse, /closet of the smaller bedroom/i);
    assert.match(result.proposedResponse, /let us know if you cannot find/i);
    assert.doesNotMatch(result.proposedResponse, /already set up/i);
    assert.doesNotMatch(result.proposedResponse, /upon request/i);
    assert.equal(result.guestArrived, true);
    console.log('[michael-in-stay-crib] proposedResponse:\n', result.proposedResponse);
  });

  it('Michael in-stay thanks: no see you soon (mock Hospitable, live Grok, PIN arrived)', async () => {
    const mockHospitable = {
      async hasGuestsOnDate() { return true; },
      async getConversationMessages() { return []; },
      async getReservationMessages() { return []; },
      async getInquiryMessages() { return []; },
      async getThreadMessages() { return []; },
    };
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      hospitableClient: mockHospitable,
      requireLiveConversationHistory: false,
      guestCheckInsLookup: async () => ({
        guestArrived: true,
        checkedInAt: '2026-08-21T20:12:00.000Z',
        checkInKey: '20150380_2026-08-21',
      }),
    });
    const result = await agent.processMessage('Thanks', {
      guestName: 'Michael',
      listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
      propertyName: 'Sunny Downtown 2 Bed Apt, Parking',
      checkIn: '2026-08-21T16:00:00-04:00',
      checkOut: '2026-08-24T10:00:00-04:00',
      asOfDate: '2026-08-21',
      asOfInstant: '2026-08-21T14:40:00-04:00',
      nowForGreeting: new Date('2026-08-21T14:40:00-04:00'),
      reservationId: 'test-michael-thanks-not-sent',
      conversation_id: 'test-michael-thanks-not-sent',
      conversationHistory: [
        { sender_type: 'guest', body: 'All set' },
        { sender_type: 'guest', body: 'Richard popped in and helped' },
      ],
    });
    assert.equal(result.shouldReply, true);
    assert.match(result.proposedResponse, /you're welcome/i);
    assert.doesNotMatch(result.proposedResponse, /see you soon/i);
    assert.doesNotMatch(result.proposedResponse, /see you then/i);
    console.log('[michael-in-stay-thanks] proposedResponse:\n', result.proposedResponse);
  });

  it('Elizabeth 3rd-dog / 2-dog-max is PET_QUESTIONS not EVENT_REQUEST (mock Hospitable, live Grok)', async () => {
    // Production 2026-08-26 Apt 3 reservation fe01d62b. Guest asked if a
    // third senior dog would be an issue given the 2-dog max. Auto matched
    // "in the unlikely event" / Thanksgiving as EVENT_REQUEST and sent the
    // no-parties decline. This is a pet-count ask, not a party.
    const elizabethMsg =
      "Hi again,  One last question.  In the unlikely event that our very senior dog is still around for Thanksgiving, will that be an issue?  She sleeps most of the time and goes on very short walks or goes in a doggy stroller.  Of course, I should've carefully read the listing about your 2 dog max";
    const priorThread = [
      {
        sender_type: 'guest',
        body: "Hi!  We look forward to staying at your home!  We are very respectful and quiet and don't mind stairs.  We are traveling with 2 well behaved dogs.  We do have a third dog, but don't believe she will make it to Thanksgiving:(. She is almost 19 years old.",
        created_at: '2026-08-26T22:26:34Z',
      },
      {
        sender_type: 'host',
        body: 'Good evening, Elizabeth, thank you for the note — sounds like a wonderful Thanksgiving trip. We love dogs and have you noted for 2 pets. The $30 pet fee is already included in your reservation. Just a reminder that pets cannot go on the beds. Check-in is at 4pm with self-check-in and you have one dedicated off-street parking spot. I will send the detailed check-in instructions 3 days before your arrival.\n\nJerome & Ruby',
        created_at: '2026-08-26T22:28:34Z',
      },
      {
        sender_type: 'guest',
        body: "Hi Jerome and Ruby,  \n\nThank you and I didn't see the bed rule.  We travel with extra sheets because we always cover the furniture everywhere we go, just out of consideration to the property owners  .Our dogs do jump on our beds at home, so I'm thinking that may be a problem.  Please let me know and I will cancel the listing.  Apologies!",
        created_at: '2026-08-27T01:30:07Z',
      },
      {
        sender_type: 'host',
        body: 'This is all good with us then! Thank you Elizabeth!',
        created_at: '2026-08-27T01:31:03Z',
      },
      {
        sender_type: 'guest',
        body: "so cancel, right?  Sorry, didn't understand your message!",
        created_at: '2026-08-27T01:32:05Z',
      },
      {
        sender_type: 'host',
        body: 'This is fine with us if we are covering the furniture\nNo need to cancel\nBut thanks for checking with us!',
        created_at: '2026-08-27T01:34:30Z',
      },
      {
        sender_type: 'guest',
        body: 'okay, just want to be transparent since you also have a strict 24 hour cancellation from moment of reservation, I wanted to double check.',
        created_at: '2026-08-27T01:36:49Z',
      },
      {
        sender_type: 'host',
        body: 'All good - thanks for checking with us again',
        created_at: '2026-08-27T01:37:12Z',
      },
      {
        sender_type: 'guest',
        body: 'Great-thank you again and good night!',
        created_at: '2026-08-27T01:37:28Z',
      },
      {
        sender_type: 'host',
        body: "You're welcome, Elizabeth! Have a good night.",
        created_at: '2026-08-27T01:38:08Z',
      },
      {
        sender_type: 'guest',
        body: elizabethMsg,
        created_at: '2026-08-27T02:30:39Z',
      },
    ];
    const mockHospitable = {
      async hasGuestsOnDate() { return false; },
      async getConversationMessages() { return priorThread; },
      async getReservationMessages() { return priorThread; },
      async getInquiryMessages() { return priorThread; },
      async getThreadMessages() { return priorThread; },
    };
    const agent = new GuestMessagingAgent({
      llm: 'auto',
      projectRoot: projectRootForTests,
      hospitableClient: mockHospitable,
      requireLiveConversationHistory: false,
    });
    const result = await agent.handleMessage(elizabethMsg, {
      guestName: 'Elizabeth',
      listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
      propertyName: '53 Pine St #3 · Cozy West End Victorian | EV Charging + Parking',
      checkIn: '2026-11-25T16:00:00-05:00',
      checkOut: '2026-11-28T10:00:00-05:00',
      asOfDate: '2026-08-26',
      asOfInstant: '2026-08-26T22:30:00-04:00',
      nowForGreeting: new Date('2026-08-26T22:30:00-04:00'),
      reservationId: 'fe01d62b-0473-45d9-9f34-efafdf0d084c',
      conversation_id: '91dfeabf-e640-4cf4-8e58-b2f468d40885',
      conversationId: '91dfeabf-e640-4cf4-8e58-b2f468d40885',
      sender_type: 'guest',
      petCount: 2,
      hasPets: true,
      conversationHistory: priorThread,
    });

    console.log('[elizabeth-third-dog] category=', result.typeOfMessageReceived);
    console.log('[elizabeth-third-dog] proposedResponse:\n', result.proposedResponse);

    assert.equal(result.shouldReply, true, 'Must auto-reply to the 3rd-dog / 2-dog-max question');
    assert.equal(
      result.typeOfMessageReceived,
      'PET_QUESTIONS',
      'Must be PET_QUESTIONS, not EVENT_REQUEST (Thanksgiving / "in the unlikely event" is not a party)'
    );
    assert.ok(result.proposedResponse && result.proposedResponse !== 'none');
    assert.match(result.proposedResponse, /maximum 2 dogs/i);
    assert.doesNotMatch(result.proposedResponse, /not able to accommodate events or gatherings/i);
    assert.doesNotMatch(result.proposedResponse, /perfect venue for your celebration/i);
    assert.doesNotMatch(result.proposedResponse, /thinking of our place for your event/i);
    assert.doesNotMatch(result.proposedResponse, /add the pets/i);
  });
});
