import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

describe('GuestMessagingAgent (mock mode)', () => {
  it('handles the Michele inquiry scenario without mentioning pet fees', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'mock',
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

  it('returns OTHER_MESSAGE + none for unclear input by default (mock)', async () => {
    const agent = new GuestMessagingAgent({
      llm: 'mock',
      projectRoot: projectRootForTests
    });
    const result = await agent.processMessage('asdfghjkl random nonsense qwerty');
    assert.equal(result.typeOfMessageReceived, 'OTHER_MESSAGE');
    assert.equal(result.proposedResponse, 'none');
  });
});
