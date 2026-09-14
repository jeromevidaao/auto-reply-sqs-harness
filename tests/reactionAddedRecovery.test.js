import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReactionAddedUpdate,
  shouldHardSkipReactionAdded,
  guestMessagePlatformId,
  guestMessageDedupKey,
} from '../src/utils/reactionAdded.js';

/**
 * Rebecca Simpkin 2026-09-12: only message.updated + reaction_added reached
 * the harness for her post-stay thank-you. Hard-skip left her unanswered.
 */
describe('reaction_added recovery (missed message.created)', () => {
  const rebeccaCtx = {
    id: 1279263956,
    platform_id: '32695385435',
    conversation_id: 'e792867b-c7e7-44b6-a7ac-2587402ba5f8',
    reservation_id: '7fd93b39-48bf-45bf-a499-fe2aa7ba6e38',
    body:
      'Hi Jerome. Thank you for a wonderful stay.  I will absolutely write a review the place was great, we loved Portland. Thanks fot hosting us.',
  };

  it('detects Hospitable reaction_added update shape', () => {
    assert.equal(
      isReactionAddedUpdate({ action: 'message.updated', triggers: ['reaction_added'] }),
      true
    );
    assert.equal(isReactionAddedUpdate({ action: 'message.created', triggers: null }), false);
    assert.equal(isReactionAddedUpdate({ action: 'message.updated', triggers: ['edited'] }), false);
  });

  it('hard-skips reaction_added ONLY when guestmsg dedup already processed', () => {
    assert.equal(
      shouldHardSkipReactionAdded({
        action: 'message.updated',
        triggers: ['reaction_added'],
        dedupAlreadyProcessed: true,
      }),
      true,
      'created already processed → skip reaction to avoid double Youre welcome'
    );
    assert.equal(
      shouldHardSkipReactionAdded({
        action: 'message.updated',
        triggers: ['reaction_added'],
        dedupAlreadyProcessed: false,
      }),
      false,
      'dedup miss → must NOT hard-skip (Rebecca recovery)'
    );
  });

  it('never hard-skips message.created', () => {
    assert.equal(
      shouldHardSkipReactionAdded({
        action: 'message.created',
        triggers: null,
        dedupAlreadyProcessed: false,
      }),
      false
    );
  });

  it('dedup key prefers Airbnb platform_id (Rebecca live ids)', () => {
    assert.equal(guestMessagePlatformId(rebeccaCtx), '32695385435');
    assert.equal(
      guestMessageDedupKey(rebeccaCtx),
      'guestmsg:e792867b-c7e7-44b6-a7ac-2587402ba5f8:32695385435'
    );
  });

  it('falls back to Hospitable numeric id when platform_id missing', () => {
    assert.equal(
      guestMessagePlatformId({ id: 1279263956, conversation_id: 'e792867b-c7e7-44b6-a7ac-2587402ba5f8' }),
      '1279263956'
    );
  });
});
