import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { setHostContactsForTests, TEST_HOST_CONTACTS } from '../src/config/hostContacts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');
setHostContactsForTests(TEST_HOST_CONTACTS);
process.env.ALLOW_HOST_CONTACT_TEST_DEFAULTS = '1';

describe('Cancellation category aliases', () => {
  it('remaps CANCELLATION_REQUEST + refund ask to CANCELLATION_POLICY (Elena CI flake)', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const msg =
      'Hi, we actually need to cancel right away. We just booked yesterday. What refund would we get?';
    const applied = agent._applyCancellationCategoryPolicy(
      { typeOfMessageReceived: 'CANCELLATION_REQUEST', proposedResponse: 'see policy' },
      msg
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'CANCELLATION_POLICY');
  });

  it('remaps bare CANCELLATION the same way', () => {
    const agent = new GuestMessagingAgent({
      projectRoot: projectRootForTests,
      llmAdapter: { complete: async () => '{}' },
    });
    const applied = agent._applyCancellationCategoryPolicy(
      { typeOfMessageReceived: 'CANCELLATION', proposedResponse: 'none' },
      'What refund would we get if we cancel?'
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.typeOfMessageReceived, 'CANCELLATION_POLICY');
  });
});
