import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chronologicalThread,
  guestMessagesAfter,
  isBareWelcomeAck,
  looksLikeWelcomeAck,
  recentHostWelcomeAck,
  shouldSkipDuplicateSend,
  runPreSendThreadRefresh,
} from '../src/utils/preSendThreadRefresh.js';

const APT2 = '114663c5-0709-4eff-a868-fa9ebd6ed42d';

function msg(sender_type, body, created_at) {
  return { sender_type, body, created_at };
}

describe('pre-send thread refresh (Michael double you-are-welcome)', () => {
  const t0 = '2026-08-21T18:40:23Z';
  const t1 = '2026-08-21T18:40:41Z';
  const t2 = '2026-08-21T18:40:43Z';
  const tHost = '2026-08-21T18:41:10Z';

  const newestFirst = [
    msg('guest', 'Thanks', t2),
    msg('guest', 'Richard popped in and helped', t1),
    msg('guest', 'All set', t0),
    msg('host', 'Did you check in the sofabed?', '2026-08-21T18:17:27Z'),
  ];

  it('orders Hospitable newest-first threads chronologically', () => {
    const chrono = chronologicalThread(newestFirst);
    assert.equal(chrono[0].body, 'Did you check in the sofabed?');
    assert.equal(chrono[chrono.length - 1].body, 'Thanks');
  });

  it('finds guest messages that arrived after the one we started processing', () => {
    const chrono = chronologicalThread(newestFirst);
    const newer = guestMessagesAfter(chrono, 'All set');
    assert.equal(newer.length, 2);
    assert.equal(newer[0].body, 'Richard popped in and helped');
    assert.equal(newer[1].body, 'Thanks');
    assert.equal(guestMessagesAfter(chrono, 'Thanks').length, 0);
  });

  it('skips a second you-are-welcome when one landed minutes earlier', () => {
    const thread = [
      msg('host', "You're welcome, Michael! See you soon.", tHost),
      msg('guest', 'Thanks', t2),
      msg('guest', 'All set', t0),
    ];
    const dup = shouldSkipDuplicateSend(thread, "You're welcome!", {
      now: Date.parse('2026-08-21T18:42:37Z'),
    });
    assert.equal(dup.skip, true);
    assert.equal(dup.reason, 'recent_youre_welcome');
  });

  it('skips a short you-are-welcome after a longer five-star thanks (Carlos)', () => {
    const thread = [
      msg(
        'host',
        "You're welcome! So glad you had a five-star stay — we appreciate it.",
        '2026-08-28T22:22:09Z'
      ),
      msg('guest', 'Thanks for everything. We had fun.', '2026-08-28T22:20:08Z'),
      msg('guest', 'Five star stay.  Absolutely!!', '2026-08-28T22:20:00Z'),
    ];
    const dup = shouldSkipDuplicateSend(thread, "You're welcome, Carlos!", {
      now: Date.parse('2026-08-28T22:23:02Z'),
    });
    assert.equal(dup.skip, true);
    assert.equal(dup.reason, 'recent_youre_welcome');
    assert.equal(
      looksLikeWelcomeAck("You're welcome! So glad you had a five-star stay — we appreciate it."),
      true
    );
    assert.equal(
      isBareWelcomeAck("You're welcome! So glad you had a five-star stay — we appreciate it."),
      false
    );
  });

  it('allows a you-are-welcome hours later (next thanks)', () => {
    const thread = [
      msg('host', "You're welcome, Michael!", '2026-08-21T16:31:15Z'),
      msg('guest', 'Thanks', '2026-08-21T18:40:43Z'),
    ];
    const dup = shouldSkipDuplicateSend(thread, "You're welcome, Michael!", {
      now: Date.parse('2026-08-21T18:42:00Z'),
    });
    assert.equal(dup.skip, false);
  });

  it('reprocesses once when newer guest messages arrived during drafting', async () => {
    let reprocessCalls = 0;
    const client = {
      async getThreadMessages() {
        return newestFirst;
      },
    };
    const out = await runPreSendThreadRefresh({
      hospitableClient: client,
      reservationId: '680feb40-0b25-49a6-a68d-45d5c6a52f18',
      originalGuestMessage: 'All set',
      originalResult: {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Michael! See you soon.",
        shouldReply: true,
      },
      context: { listingId: APT2, guestName: 'Michael' },
      reprocess: async (latest, ctx) => {
        reprocessCalls += 1;
        assert.equal(latest, 'Thanks');
        assert.ok(ctx._preSendReprocessed);
        assert.equal(ctx.preSendOriginalGuestMessage, 'All set');
        assert.deepEqual(ctx.preSendNewerGuestMessages, [
          'Richard popped in and helped',
          'Thanks',
        ]);
        assert.match(ctx.preSendStaleDraft, /see you soon/i);
        assert.ok(ctx.conversationHistory.some((m) => /Richard popped in/i.test(m.body)));
        return {
          typeOfMessageReceived: 'THANK_YOU_MESSAGE',
          proposedResponse: "You're welcome, Michael!",
          shouldReply: true,
        };
      },
    });
    assert.equal(reprocessCalls, 1);
    assert.equal(out.reprocessed, true);
    assert.equal(out.skipSend, false);
    assert.equal(out.result.proposedResponse, "You're welcome, Michael!");
  });

  it('skips send when a sibling Lambda already posted you-are-welcome', async () => {
    const now = Date.parse('2026-08-21T18:42:37Z');
    const client = {
      async getThreadMessages() {
        return [
          msg('host', "You're welcome, Michael! See you soon.", tHost),
          msg('guest', 'Thanks', t2),
          msg('guest', 'All set', t0),
        ];
      },
    };
    const out = await runPreSendThreadRefresh({
      hospitableClient: client,
      reservationId: 'res-1',
      originalGuestMessage: 'Thanks',
      originalResult: {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome!",
        shouldReply: true,
      },
      context: {},
      now,
      reprocess: async () => {
        throw new Error('should not reprocess — no newer guest messages after Thanks');
      },
    });
    assert.equal(out.reprocessed, false);
    assert.equal(out.skipSend, true);
    assert.equal(out.reason, 'recent_youre_welcome');
  });

  it('does not reprocess twice', async () => {
    const client = {
      async getThreadMessages() {
        return newestFirst;
      },
    };
    const out = await runPreSendThreadRefresh({
      hospitableClient: client,
      reservationId: 'res-1',
      originalGuestMessage: 'All set',
      originalResult: {
        proposedResponse: "You're welcome, Michael!",
        shouldReply: true,
      },
      context: { _preSendReprocessed: true },
      alreadyReprocessed: true,
      reprocess: async () => {
        throw new Error('already reprocessed');
      },
    });
    assert.equal(out.reprocessed, false);
    assert.equal(out.skipSend, false);
  });

  it('reuses a fresh live thread and does not GET again', async () => {
    let gets = 0;
    const client = {
      async getThreadMessages() {
        gets += 1;
        throw new Error('should not GET when live thread is fresh');
      },
    };
    const fetchedAt = Date.parse('2026-08-21T18:41:16Z');
    const out = await runPreSendThreadRefresh({
      hospitableClient: client,
      reservationId: 'res-1',
      originalGuestMessage: 'Thanks',
      originalResult: {
        proposedResponse: "You're welcome!",
        shouldReply: true,
      },
      existingThread: newestFirst,
      liveFetchedAt: fetchedAt,
      now: fetchedAt + 1200,
      reuseMaxAgeMs: 8000,
      reprocess: async () => {
        throw new Error('should not reprocess — Thanks is the latest guest turn');
      },
    });
    assert.equal(gets, 0);
    assert.equal(out.reusedLiveThread, true);
    assert.equal(out.reprocessed, false);
  });

  it('always GETs before send by default (Carlos in-flight must see the new thanks)', async () => {
    let gets = 0;
    const client = {
      async getThreadMessages() {
        gets += 1;
        return newestFirst;
      },
    };
    const fetchedAt = Date.parse('2026-08-21T18:41:16Z');
    const out = await runPreSendThreadRefresh({
      hospitableClient: client,
      reservationId: 'res-1',
      originalGuestMessage: 'Thanks',
      originalResult: {
        proposedResponse: "You're welcome!",
        shouldReply: true,
      },
      existingThread: [msg('guest', 'Thanks', t2)],
      liveFetchedAt: fetchedAt,
      now: fetchedAt + 1200,
    });
    assert.equal(gets, 1);
    assert.equal(out.reusedLiveThread, false);
  });

  it('GETs when the live thread is stale (LLM took longer than reuse window)', async () => {
    let gets = 0;
    const client = {
      async getThreadMessages() {
        gets += 1;
        return newestFirst;
      },
    };
    const fetchedAt = Date.parse('2026-08-21T18:41:16Z');
    const out = await runPreSendThreadRefresh({
      hospitableClient: client,
      reservationId: 'res-1',
      originalGuestMessage: 'Thanks',
      originalResult: {
        proposedResponse: "You're welcome!",
        shouldReply: true,
      },
      existingThread: [msg('guest', 'Thanks', t2)],
      liveFetchedAt: fetchedAt,
      now: fetchedAt + 20_000,
    });
    assert.equal(gets, 1);
    assert.equal(out.reusedLiveThread, false);
  });

  it('isBareWelcomeAck matches short acks only', () => {
    assert.equal(isBareWelcomeAck("You're welcome, Michael!"), true);
    assert.equal(isBareWelcomeAck("You're welcome!"), true);
    assert.equal(isBareWelcomeAck("You're welcome, Michael! See you soon."), true);
    assert.equal(
      isBareWelcomeAck(
        "You're welcome, Michael! Lift up the long part of the sofa to reveal the sheets."
      ),
      false
    );
    assert.equal(recentHostWelcomeAck([], {}), false);
  });
});
