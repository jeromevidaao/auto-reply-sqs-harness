import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraftClaims } from '../src/harness/claimCheck.js';

describe('claimCheck: Tracy coffee maker / Keurig', () => {
  it('flags deferral and forces Keurig reply', () => {
    const r = checkDraftClaims({
      draft: "I'll check on the coffee maker and get back to you shortly.",
      guestMessage: 'What coffee maker do you have in the apartment?',
      context: { guestName: 'Tracy' },
    });
    assert.ok(r.issues.some((i) => i.code === 'coffee_maker_deferral'));
    assert.ok(r.revisedResponse);
    assert.match(r.revisedResponse, /Keurig/i);
    assert.ok(!/i'?ll check|get back/i.test(r.revisedResponse));
  });

  it('flags missing Keurig even without deferral wording', () => {
    const r = checkDraftClaims({
      draft: 'We have a coffee machine for guests.',
      guestMessage: 'Is there a Keurig or coffee maker?',
      context: { guestName: 'Tracy' },
    });
    assert.ok(r.issues.some((i) => i.code === 'coffee_maker_deferral'));
    assert.match(r.revisedResponse || '', /Keurig/i);
  });

  it('ok when draft already has Keurig and no hedge', () => {
    const r = checkDraftClaims({
      draft: 'We have a Keurig machine in every apartment. Feel free to bring your own pods or filters if you prefer.',
      guestMessage: 'What coffee maker do you have?',
      context: { guestName: 'Tracy' },
    });
    assert.ok(!r.issues.some((i) => i.code === 'coffee_maker_deferral'));
  });
});
