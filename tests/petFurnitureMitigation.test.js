import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import {
  PET_FURNITURE_MITIGATION_SNIPPET,
  isPetFurnitureMitigation,
} from '../src/tools/pets/petFurnitureMitigation.js';
import { isPetOverMaxAsk } from '../src/tools/pets/petOverMax.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

const ELIZABETH_FURNITURE_MSG =
  "Hi Jerome and Ruby,  \n\nThank you and I didn't see the bed rule.  We travel with extra sheets because we always cover the furniture everywhere we go, just out of consideration to the property owners  .Our dogs do jump on our beds at home, so I'm thinking that may be a problem.  Please let me know and I will cancel the listing.  Apologies!";

const HARSH_DRAFT =
  "Good evening Elizabeth, thank you — we appreciate you covering the furniture. The pet rule is firm though, so dogs can't go on the beds. If that won't work for your stay, please review our strict cancellation policy here: https://www.airbnb.com/help/article/475.";

describe('Pet furniture mitigation (Elizabeth Apt 3 2026-08-27)', () => {
  it('detects covering furniture with extra sheets as strong mitigation', () => {
    assert.equal(isPetFurnitureMitigation(ELIZABETH_FURNITURE_MSG), true);
    assert.equal(
      isPetFurnitureMitigation(
        'We will cover all the furniture with linens so the dogs stay off the upholstery.'
      ),
      true
    );
  });

  it('does not fire on checkout housekeeping or extra-linen asks', () => {
    assert.equal(
      isPetFurnitureMitigation(
        'Good Morning Jerome! We have officially checked out. We pulled the linens, and gathered all of the trash in one area.'
      ),
      false
    );
    assert.equal(
      isPetFurnitureMitigation(
        'Hi, could we get extra towels and linens? We cannot find them under the sofa.'
      ),
      false
    );
  });

  it('does not steal the 3rd-dog / 2-dog-max ask', () => {
    const third =
      "In the unlikely event that our very senior dog is still around for Thanksgiving, will that be an issue? Of course, I should've carefully read the listing about your 2 dog max";
    assert.equal(isPetOverMaxAsk(third), true);
    assert.equal(isPetFurnitureMitigation(third), false);
  });

  it('policy rewrites a 475 / firm-rule draft to fine + no cancel', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const parsed = {
      typeOfMessageReceived: 'CANCELLATION',
      proposedResponse: HARSH_DRAFT,
      shouldReply: true,
    };
    const applied = agent._applyPetFurnitureMitigationPolicy(
      parsed,
      { guestName: 'Elizabeth' },
      ELIZABETH_FURNITURE_MSG
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.shouldReply, true);
    assert.equal(applied.typeOfMessageReceived, 'PET_QUESTIONS');
    assert.match(applied.proposedResponse, /fine with us/i);
    assert.match(applied.proposedResponse, /cover the furniture/i);
    assert.match(applied.proposedResponse, /No need to cancel/i);
    assert.doesNotMatch(applied.proposedResponse, /help\/article\/475/i);
    assert.doesNotMatch(applied.proposedResponse, /pet rule is firm/i);
    assert.ok(PET_FURNITURE_MITIGATION_SNIPPET.includes('fine with us'));
  });

  it('processMessage overrides a harsh LLM draft (no live Grok)', async () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: {
        complete: async () =>
          JSON.stringify({
            typeOfMessageReceived: 'CANCELLATION',
            proposedResponse: HARSH_DRAFT,
            shouldReply: true,
            confidence: 0.9,
          }),
      },
      requireLiveConversationHistory: false,
    });
    const result = await agent.processMessage(ELIZABETH_FURNITURE_MSG, {
      guestName: 'Elizabeth',
      listingId: '60fc0321-c8be-46f4-8edd-8f5cd2c6c7bd',
      propertyName: '53 Pine St #3 · Cozy West End Victorian | EV Charging + Parking',
      checkIn: '2026-11-25T16:00:00-05:00',
      checkOut: '2026-11-28T10:00:00-05:00',
      petCount: 2,
      hasPets: true,
      conversationHistory: [],
    });
    assert.equal(result.shouldReply, true);
    assert.equal(result.typeOfMessageReceived, 'PET_QUESTIONS');
    assert.match(result.proposedResponse, /fine with us/i);
    assert.match(result.proposedResponse, /No need to cancel/i);
    assert.doesNotMatch(result.proposedResponse, /help\/article\/475/i);
    assert.doesNotMatch(result.proposedResponse, /pet rule is firm/i);
  });
});
