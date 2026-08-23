import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunItem,
  clipHistory,
  explainWhy,
  persistGuestMessagingRun,
  resolveOutcome,
  RUN_PK,
} from '../src/utils/runMonitor.js';

describe('runMonitor', () => {
  it('clips conversation history and normalizes roles', () => {
    const clipped = clipHistory([
      { sender_type: 'guest', body: 'Hi', created_at: '2026-08-21T12:00:00Z', sender_name: 'Michael' },
      { role: 'host', text: 'Hello', createdAt: '2026-08-21T12:01:00Z' },
      { isHost: true, message: 'x'.repeat(2000) },
    ]);
    assert.equal(clipped.length, 3);
    assert.equal(clipped[0].role, 'guest');
    assert.equal(clipped[0].name, 'Michael');
    assert.equal(clipped[1].role, 'host');
    assert.ok(clipped[2].body.endsWith('…'));
    assert.ok(clipped[2].body.length <= 1500);
  });

  it('classifies sent vs decided-not-to-answer', () => {
    assert.equal(resolveOutcome({ result: { shouldReply: true }, extra: { sent: true } }), 'sent');
    assert.equal(resolveOutcome({ result: { shouldReply: false } }), 'no_reply');
    assert.equal(resolveOutcome({ result: { escalated: true } }), 'escalated');
    assert.equal(resolveOutcome({ extra: { skipReason: 'Pre-send guard', sent: false } }), 'skipped');
    assert.equal(resolveOutcome({ extra: { error: 'boom' } }), 'error');
  });

  it('explains why a reply was sent or withheld', () => {
    const sentWhy = explainWhy({
      result: {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        confidence: 0.92,
        conversationJudge: { verdict: 'APPROVED' },
      },
      extra: { sent: true },
    });
    assert.match(sentWhy, /Answered as THANK_YOU_MESSAGE/);
    assert.match(sentWhy, /Judge: APPROVED/);

    const noWhy = explainWhy({
      result: {
        typeOfMessageReceived: 'OTHER_MESSAGE',
        shouldReply: false,
        proposedResponse: 'none',
      },
    });
    assert.match(noWhy, /Decided not to answer/);
    assert.match(noWhy, /OTHER_MESSAGE/);
  });

  it('builds a Dynamo item with RUN pk and ISO sort key', () => {
    const item = buildRunItem({
      requestId: 'abc-123',
      startTime: Date.parse('2026-08-21T15:04:05.000Z'),
      durationMs: 12345,
      guestMessage: 'Where is the crib?',
      platform: 'airbnb',
      context: {
        guestName: 'Michael',
        propertyName: 'Pine Apt #2',
        conversation_id: 'conv-1',
        conversationHistory: [
          { sender_type: 'guest', body: 'Just entered. Where is the crib?' },
        ],
      },
      result: {
        typeOfMessageReceived: 'CRIB_PACK_AND_PLAY',
        shouldReply: true,
        proposedResponse: 'The crib is in the closet of the smaller bedroom.',
        confidence: 1,
        conversationJudge: { verdict: 'APPROVED' },
      },
      extra: { sent: true, platform: 'airbnb', act: 'message' },
    });
    assert.equal(item.pk, RUN_PK);
    assert.equal(item.sk, '2026-08-21T15:04:05.000Z#abc-123');
    assert.equal(item.outcome, 'sent');
    assert.equal(item.answered, true);
    assert.equal(item.durationMs, 12345);
    assert.equal(item.category, 'CRIB_PACK_AND_PLAY');
    assert.equal(item.guestName, 'Michael');
    assert.equal(item.conversationHistory.length, 1);
    assert.ok(item.why.includes('Answered as CRIB_PACK_AND_PLAY'));
    assert.ok(item.expiresAt > 0);
  });

  it('persists live-fetched thread from earlyTraces when context history is empty', () => {
    const item = buildRunItem({
      requestId: 'live-hist',
      startTime: 1,
      durationMs: 10,
      guestMessage: 'Thanks',
      context: { guestName: 'Kailyn', conversationHistory: [] },
      result: {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        shouldReply: true,
        proposedResponse: "You're welcome, Kailyn!",
        earlyTraces: {
          conversationTraces: {
            recentConversationMessages: [
              { sender_type: 'guest', body: 'Hi', created_at: '2026-08-22T12:00:00Z' },
              { sender: { type: 'host', name: 'Jerome' }, body: 'Welcome!' },
              { sender_type: 'guest', body: 'Thanks' },
            ],
          },
        },
      },
      extra: { sent: true },
    });
    assert.equal(item.conversationHistory.length, 3);
    assert.equal(item.conversationHistory[1].role, 'host');
    assert.equal(item.conversationHistory[1].name, 'Jerome');
    assert.equal(item.conversationHistory[2].body, 'Thanks');
  });

  it('persistGuestMessagingRun never throws and uses injected put', async () => {
    const seen = [];
    const out = await persistGuestMessagingRun(
      {
        requestId: 'r1',
        startTime: 1,
        durationMs: 50,
        result: { typeOfMessageReceived: 'OTHER_MESSAGE', shouldReply: false },
        extra: { sent: false },
      },
      { put: async (item) => { seen.push(item); } }
    );
    assert.equal(out.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].outcome, 'no_reply');

    const failed = await persistGuestMessagingRun(
      { requestId: 'r2', startTime: 1, extra: { sent: false } },
      { put: async () => { throw new Error('ddb down'); } }
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error, /ddb down/);
  });
});
