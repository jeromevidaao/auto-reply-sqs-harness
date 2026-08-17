import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHomeExchangePayload,
  extractHomeExchangeMessage,
  HOMEEXCHANGE_CHECKIN_ACT,
  HOMEEXCHANGE_PLATFORM,
} from '../src/useCases/homeExchange.js';
import {
  guestFinalizedHeExchange,
  thisTurnWantsHePreapprove,
} from '../src/useCases/homeExchangeSharedCategories.js';
import {
  handleHeCheckinInstructions,
  isHeCheckinInstructionsTurn,
  extractPhoneLast4,
  fillCheckinTemplate,
  verifyCheckinDraft,
  resolveHeUnitStrict,
  resolveCheckinHomeId,
  buildCheckinPersonalLine,
  HOMEEXCHANGE_CHECKIN_REASON,
} from '../src/useCases/homeExchangeCheckin.js';
import { bundledCheckinTemplate } from '../src/useCases/checkinTemplates/index.js';
import { alreadySentEquivalent } from '../src/clients/HomeExchangeClient.js';
import { buildHeAutoReplyNotify, HE_NOTIFY_SENT, HE_NOTIFY_SEND_FAILED } from '../src/useCases/homeExchangeNotify.js';

function checkinEvent({ homeId, guestName, last4, phone, conversationId = '1', history = [] }) {
  return {
    queryStringParameters: { act: HOMEEXCHANGE_CHECKIN_ACT },
    body: JSON.stringify({
      action: 'homeexchange.checkin_instructions',
      data: {
        body: 'Send check-in instructions',
        platform: HOMEEXCHANGE_PLATFORM,
        source: HOMEEXCHANGE_PLATFORM,
        eventType: 'checkin_instructions',
        conversation_id: conversationId,
        guestName,
        guestPhone: phone || null,
        guestPhoneLast4: last4 || null,
        phoneNumber: phone || null,
        checkIn: '2026-08-20',
        checkOut: '2026-08-23',
        isFirstMessage: false,
        listing: { platform: 'homeexchange', platform_id: homeId },
        conversationHistory: history,
      },
    }),
  };
}

describe('HE check-in last-4 + unit matching', () => {
  it('extracts NANP last-4 the same way Schlage does', () => {
    assert.equal(extractPhoneLast4(['+1 (555) 555-2493']), '2493');
    assert.equal(extractPhoneLast4(['+15555553719']), '3719');
    assert.equal(extractPhoneLast4(['12']), null);
  });

  it('never resolves an unknown home to Apt #3', () => {
    assert.equal(resolveHeUnitStrict('3285044').propertyName, 'Pine Apt #2');
    assert.equal(resolveHeUnitStrict('3285159').propertyName, 'Pine Apt #1B');
    assert.equal(resolveHeUnitStrict('3202475').propertyName, 'Pine Apt #3');
    assert.equal(resolveHeUnitStrict('999'), null);
    assert.equal(resolveHeUnitStrict(null), null);
  });

  it('aborts when payload home and live exchange home disagree', () => {
    const resolved = resolveCheckinHomeId({
      context: { listing: { platform_id: '3285044' } },
      liveExchange: { home: { id: 3202475 } },
    });
    assert.equal(resolved.homeId, null);
    assert.equal(resolved.error, 'payload_live_home_mismatch');
  });
});

describe('HE check-in template fill + verify', () => {
  it('fills last-4 and keeps unit-specific facts for all three listings', () => {
    const cases = [
      { homeId: '3285159', last4: '4906', must: ['Apt 1B', 'BACK entrance', '4906'], mustNot: ['9751', 'APT 2'] },
      { homeId: '3285044', last4: '2030', must: ['APT 2', 'rear of the building', '2030'], mustNot: ['9751', 'Apt 1B'] },
      { homeId: '3202475', last4: '7672', must: ['Apt 3', 'FRONT entrance', '9751', '7672'], mustNot: ['Apt 1B', 'APT 2'] },
    ];
    for (const c of cases) {
      const tpl = bundledCheckinTemplate(c.homeId);
      assert.ok(tpl, c.homeId);
      assert.equal(tpl.homeId, c.homeId);
      const body = fillCheckinTemplate(tpl.template, { firstName: 'Ada', last4: c.last4 });
      const verify = verifyCheckinDraft(body, tpl, c.last4);
      assert.equal(verify.ok, true, `${c.homeId} ${verify.reasons}`);
      for (const n of c.must) assert.match(body, new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      for (const n of c.mustNot) assert.equal(body.includes(n), false, `${c.homeId} leaked ${n}`);
    }
  });

  it('fails verify if last-4 is missing or another unit leaks in', () => {
    const tpl = bundledCheckinTemplate('3285044');
    const body = fillCheckinTemplate(tpl.template, { firstName: 'Ada', last4: '2030' });
    assert.equal(verifyCheckinDraft(body, tpl, null).ok, false);
    assert.equal(verifyCheckinDraft(body + '\n9751', tpl, '2030').ok, false);
  });

  it('adds a short personal line from history without dropping the body', () => {
    const line = buildCheckinPersonalLine(
      [{ sender_type: 'guest', content: 'We will arrive late after 8pm' }],
      'Katie'
    );
    assert.match(line, /after 4pm/);
  });
});

describe('HE check-in SQS payload detection', () => {
  it('is HE traffic and not a finalize thank-you', () => {
    const event = checkinEvent({ homeId: '3285044', guestName: 'Katie', last4: '2030' });
    assert.equal(isHomeExchangePayload(event), true);
    const extracted = extractHomeExchangeMessage(event);
    assert.equal(isHeCheckinInstructionsTurn(extracted.context, extracted.message, event), true);
    assert.equal(guestFinalizedHeExchange(extracted.message, extracted.context), false);
    assert.equal(thisTurnWantsHePreapprove(extracted.message, extracted.context), false);
    assert.equal(extracted.context.guestPhoneLast4, '2030');
    assert.equal(extracted.context.homeId, '3285044');
    assert.equal(extracted.context.propertyName, 'Pine Apt #2');
  });
});

describe('handleHeCheckinInstructions', () => {
  it('sends Apt #2 instructions with last-4 and notifies Android', async () => {
    const sent = [];
    const notifies = [];
    const result = await handleHeCheckinInstructions({
      event: checkinEvent({
        homeId: '3285044',
        guestName: 'Jeffrey',
        last4: '2030',
        phone: '+15555552030',
        conversationId: '885',
      }),
      homeExchangeClient: {
        async listMessages() {
          return [];
        },
        async getConversation() {
          return {
            exchanges: [
              {
                status: 3,
                start_on: '2026-08-20',
                end_on: '2026-08-23',
                home: { id: 3285044 },
                guest: { first_name: 'Jeffrey', phone: '+15555552030' },
              },
            ],
          };
        },
        async sendMessage(_id, content) {
          sent.push(content);
          return { ok: true };
        },
        async approveConversation() {
          throw new Error('must not pre-approve on check-in');
        },
      },
      notifyOwner: async (n) => {
        notifies.push(n);
        return { ok: true };
      },
    });
    assert.equal(result.sent, true);
    assert.equal(result.checkinInstructions, true);
    assert.equal(result.preapprove.attempted, false);
    assert.equal(result.homeId, '3285044');
    assert.equal(result.unit.propertyName, 'Pine Apt #2');
    assert.equal(result.last4, '2030');
    assert.match(sent[0], /Jeffrey/);
    assert.match(sent[0], /2030/);
    assert.match(sent[0], /APT 2/);
    assert.equal(sent[0].includes('9751'), false);
    assert.equal(sent[0].includes('Apt 1B'), false);
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0].type, HE_NOTIFY_SENT);
    assert.match(notifies[0].title, /check-in instructions sent/);
    assert.equal(alreadySentEquivalent([{ content: sent[0] }], sent[0]), true);
  });

  it('sends Apt #1B back-entrance template and Apt #3 lockbox template', async () => {
    for (const c of [
      { homeId: '3285159', name: 'Thomas', last4: '4906', must: /BACK entrance/, mustNot: /9751/ },
      { homeId: '3202475', name: 'Erica', last4: '7672', must: /9751/, mustNot: /Apt 1B/ },
    ]) {
      const sent = [];
      const result = await handleHeCheckinInstructions({
        event: checkinEvent({
          homeId: c.homeId,
          guestName: c.name,
          last4: c.last4,
          conversationId: 'u' + c.homeId,
        }),
        homeExchangeClient: {
          async listMessages() {
            return [];
          },
          async getConversation() {
            return {
              exchanges: [{ home: { id: Number(c.homeId) }, guest: { first_name: c.name } }],
            };
          },
          async sendMessage(_id, content) {
            sent.push(content);
            return { ok: true };
          },
        },
        notifyOwner: async () => ({ ok: true }),
      });
      assert.equal(result.sent, true, c.homeId);
      assert.equal(result.homeId, c.homeId);
      assert.match(sent[0], c.must);
      assert.equal(c.mustNot.test(sent[0]), false, c.homeId);
      assert.match(sent[0], new RegExp(c.last4));
    }
  });

  it('does not send without last-4 and still notifies Android', async () => {
    const sent = [];
    const notifies = [];
    const result = await handleHeCheckinInstructions({
      event: checkinEvent({ homeId: '3285044', guestName: 'Jeffrey', conversationId: 'x' }),
      homeExchangeClient: {
        async listMessages() {
          return [];
        },
        async getConversation() {
          return { exchanges: [{ home: { id: 3285044 }, guest: { first_name: 'Jeffrey' } }] };
        },
        async sendMessage(_id, content) {
          sent.push(content);
          return { ok: true };
        },
      },
      notifyOwner: async (n) => {
        notifies.push(n);
        return { ok: true };
      },
    });
    assert.equal(result.sent, false);
    assert.equal(result.sendError, 'missing_guest_phone_last4');
    assert.deepEqual(sent, []);
    assert.equal(notifies[0].type, HE_NOTIFY_SEND_FAILED);
  });

  it('does not send when the live stay is a different unit', async () => {
    const sent = [];
    const result = await handleHeCheckinInstructions({
      event: checkinEvent({
        homeId: '3285044',
        guestName: 'Katie',
        last4: '1111',
        conversationId: 'mismatch',
      }),
      homeExchangeClient: {
        async listMessages() {
          return [];
        },
        async getConversation() {
          return { exchanges: [{ home: { id: 3202475 }, guest: { first_name: 'Katie' } }] };
        },
        async sendMessage(_id, content) {
          sent.push(content);
          return { ok: true };
        },
      },
      notifyOwner: async () => ({ ok: true }),
    });
    assert.equal(result.sent, false);
    assert.equal(result.sendError, 'payload_live_home_mismatch');
    assert.deepEqual(sent, []);
  });

  it('skips when the check-in template is already on the thread', async () => {
    const tpl = bundledCheckinTemplate('3285044');
    const existing = fillCheckinTemplate(tpl.template, { firstName: 'Jeffrey', last4: '2030' });
    let sends = 0;
    const result = await handleHeCheckinInstructions({
      event: checkinEvent({
        homeId: '3285044',
        guestName: 'Jeffrey',
        last4: '2030',
        conversationId: 'again',
      }),
      homeExchangeClient: {
        async listMessages() {
          return [{ content: existing }];
        },
        async getConversation() {
          return { exchanges: [{ home: { id: 3285044 } }] };
        },
        async sendMessage() {
          sends += 1;
          return { ok: true };
        },
      },
      notifyOwner: async () => ({ ok: true }),
    });
    assert.equal(result.sent, false);
    assert.equal(result.sendSkipReason, 'already_sent');
    assert.equal(sends, 0);
  });
});

describe('HE check-in owner FCM copy', () => {
  it('uses a distinct sent title', () => {
    const n = buildHeAutoReplyNotify({
      kind: 'sent',
      guestName: 'Jeffrey',
      checkIn: '2026-08-20',
      checkOut: '2026-08-23',
      propertyName: 'Pine Apt #2',
      reason: HOMEEXCHANGE_CHECKIN_REASON,
      proposedResponse: 'Hi Jeffrey,\n\nIt\'s almost time',
    });
    assert.equal(n.type, HE_NOTIFY_SENT);
    assert.match(n.title, /check-in instructions sent/);
    assert.match(n.body, /Pine Apt #2/);
  });
});
