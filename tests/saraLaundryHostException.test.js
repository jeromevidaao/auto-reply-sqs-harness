import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestMessagingAgent } from '../src/agent.js';
import { ConversationContextTool } from '../src/tools/conversation/ConversationContextTool.js';
import {
  chronologicalThread,
  guestMessagesAfter,
  hostMessagesAfter,
  runPreSendThreadRefresh,
} from '../src/utils/preSendThreadRefresh.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRootForTests = path.resolve(__dirname, '..');

/** Sara · Pineland Portland ME — Jerome one-time washer/dryer exception, then Soap Bubble auto-reply. */
const SARA_GUEST_LAUNDRY =
  "Richard unlocked a room that has a washer and dryer in it — our comforter is still a bit damp and we'd love to dry it if that's ok?";

const HOST_EXCEPTION =
  'Yes - Sara, this is not for guests usually but for this time feel free to use it!';

const BAD_SOAP_BUBBLE =
  'Hi Sara, we do not have laundry on site, but there is a laundromat next door called Soap Bubble that is very accessible. Address: 68 Pine St, Portland, ME 04102';

const HISTORY_WITH_EXCEPTION = [
  {
    role: 'guest',
    sender_type: 'guest',
    body: SARA_GUEST_LAUNDRY,
    content: SARA_GUEST_LAUNDRY,
    created_at: '2026-09-21T20:55:00Z',
  },
  {
    role: 'host',
    sender_type: 'host',
    body: HOST_EXCEPTION,
    content: HOST_EXCEPTION,
    created_at: '2026-09-21T20:58:00Z',
  },
];

function makeAgent() {
  return new GuestMessagingAgent({
    projectRoot: projectRootForTests,
    llmAdapter: { complete: async () => '{}' },
  });
}

function saraCtx(extra = {}) {
  return {
    guestName: 'Sara',
    guestDisplayName: 'Sara',
    checkIn: '2026-09-20',
    checkOut: '2026-09-23',
    listingId: '114663c5-0709-4eff-a868-fa9ebd6ed42d',
    propertyName: 'Sunny Apt 2 · Pineland Portland ME',
    conversationHistory: HISTORY_WITH_EXCEPTION,
    conversationTraces: {
      earlyUnitReadyOffered: false,
      hostGrantedException: true,
      hostLaundryExceptionGranted: true,
      hostExceptionMessagePreview: HOST_EXCEPTION,
      hasRecentHostMessage: true,
      ...(extra.conversationTraces || {}),
    },
    ...extra,
  };
}

function msg(sender_type, body, created_at) {
  return { sender_type, body, created_at };
}

describe('Sara laundry host exception (Jerome one-time washer/dryer)', () => {
  it('ConversationContextTool detects host-granted laundry exception in history', async () => {
    const tool = new ConversationContextTool({ hospitableClient: null });
    const result = await tool.execute(SARA_GUEST_LAUNDRY, {
      conversationHistory: HISTORY_WITH_EXCEPTION,
      requireLiveHistory: false,
    });
    assert.equal(result.hostGrantedException, true, 'hostGrantedException must be true');
    assert.equal(result.hostLaundryExceptionGranted, true, 'hostLaundryExceptionGranted must be true');
    assert.match(String(result.hostExceptionMessagePreview || ''), /feel free to use it/i);
  });

  it('_applyLaundryPolicy must NOT dump Soap Bubble when host already granted laundry exception', () => {
    const agent = makeAgent();
    const ctx = saraCtx();
    const applied = agent._applyLaundryPolicy(
      {
        typeOfMessageReceived: 'LAUNDRY_QUESTION',
        proposedResponse: BAD_SOAP_BUBBLE,
        shouldReply: true,
      },
      ctx,
      SARA_GUEST_LAUNDRY
    );
    assert.equal(agent._hostGrantedLaundryException(ctx), true);
    // Must either skip stock force, or replace with an exception-honoring ack — never keep Soap Bubble denial.
    if (applied.applied) {
      assert.doesNotMatch(
        applied.proposedResponse || '',
        /soap bubble|do not have laundry on site|no laundry on site/i,
        'must not keep Soap Bubble / no-on-site denial after host exception'
      );
      assert.match(
        applied.proposedResponse || '',
        /feel free|go ahead|this time|washer|dryer|as (?:we|the host) (?:said|mentioned)|you(?:'|’)re (?:all )?set/i,
        'replacement must honor the host exception'
      );
    } else {
      // If policy declines to overwrite, the draft still contradicts — callers rely on judge guard.
      // Prefer applied=true with honor ack so first-pass cannot emit Soap Bubble.
      assert.fail('expected _applyLaundryPolicy to rewrite contradicting Soap Bubble draft when host exception is present');
    }
  });

  it('stock laundry Soap Bubble still applies when there is NO host exception (Henry regression)', () => {
    const agent = makeAgent();
    const applied = agent._applyLaundryPolicy(
      {
        typeOfMessageReceived: 'LAUNDRY_QUESTION',
        proposedResponse: "I'll check on laundry and get back shortly.",
        shouldReply: true,
      },
      {
        guestName: 'Henry',
        conversationHistory: [],
        conversationTraces: { hostLaundryExceptionGranted: false, hostGrantedException: false },
      },
      'Is there laundry on site?'
    );
    assert.equal(applied.applied, true);
    assert.match(applied.proposedResponse || '', /soap bubble/i);
    assert.match(applied.proposedResponse || '', /68 pine/i);
    assert.match(applied.proposedResponse || '', /do not have laundry on site|no laundry on site/i);
  });

  it('deterministic judge guard: Soap Bubble draft + host laundry exception → REVISE (not APPROVE)', () => {
    const agent = makeAgent();
    const ctx = saraCtx();
    const out = agent._applyDeterministicJudgeGuards(
      { verdict: 'APPROVE', notes: 'llm missed host exception', issues: [] },
      {
        typeOfMessageReceived: 'LAUNDRY_QUESTION',
        proposedResponse: BAD_SOAP_BUBBLE,
        shouldReply: true,
      },
      ctx,
      SARA_GUEST_LAUNDRY
    );
    assert.ok(['REVISE', 'REJECT'].includes(out.verdict), `verdict=${out.verdict}`);
    assert.notEqual(out.verdict, 'APPROVE');
    assert.equal(out.deterministicGuard, true);
    if (out.verdict === 'REVISE') {
      assert.doesNotMatch(out.revisedResponse || '', /soap bubble|do not have laundry on site|no laundry on site/i);
      assert.match(
        out.revisedResponse || '',
        /feel free|go ahead|this time|washer|dryer|as (?:we|the host) (?:said|mentioned)|you(?:'|’)re (?:all )?set/i
      );
    }
  });
});

describe('pre-send: mid-compose new host OR guest message forces rework', () => {
  it('hostMessagesAfter finds host replies that landed after the guest message we are answering', () => {
    const thread = chronologicalThread([
      msg('host', HOST_EXCEPTION, '2026-09-21T20:58:00Z'),
      msg('guest', SARA_GUEST_LAUNDRY, '2026-09-21T20:55:00Z'),
      msg('host', 'Welcome!', '2026-09-20T18:00:00Z'),
    ]);
    const newerHost = hostMessagesAfter(thread, SARA_GUEST_LAUNDRY);
    assert.equal(newerHost.length, 1);
    assert.match(newerHost[0].body, /feel free to use it/i);
  });

  it('mid-compose new HOST message (exception) → reprocess with refreshed history', async () => {
    let reprocessCalls = 0;
    const liveThread = [
      msg('host', HOST_EXCEPTION, '2026-09-21T20:58:00Z'),
      msg('guest', SARA_GUEST_LAUNDRY, '2026-09-21T20:55:00Z'),
    ];
    const client = {
      async getThreadMessages() {
        return liveThread;
      },
    };
    const out = await runPreSendThreadRefresh({
      hospitableClient: client,
      reservationId: 'sara-laundry-res',
      originalGuestMessage: SARA_GUEST_LAUNDRY,
      originalResult: {
        typeOfMessageReceived: 'LAUNDRY_QUESTION',
        proposedResponse: BAD_SOAP_BUBBLE,
        shouldReply: true,
      },
      context: { guestName: 'Sara' },
      reprocess: async (latest, ctx) => {
        reprocessCalls += 1;
        assert.ok(ctx._preSendReprocessed);
        assert.ok(
          Array.isArray(ctx.preSendNewerHostMessages) && ctx.preSendNewerHostMessages.length >= 1,
          'must surface newer host messages'
        );
        assert.match(ctx.preSendNewerHostMessages.join('\n'), /feel free to use it/i);
        assert.ok(
          ctx.conversationHistory.some((m) => /feel free to use it/i.test(m.body || '')),
          'must refetch/pass full history including host exception'
        );
        assert.match(ctx.preSendStaleDraft || '', /soap bubble/i);
        return {
          typeOfMessageReceived: 'LAUNDRY_QUESTION',
          proposedResponse:
            'Yes Sara — as we said, feel free to use the washer and dryer this time!',
          shouldReply: true,
        };
      },
    });
    assert.equal(reprocessCalls, 1, 'must reprocess when a new host message landed mid-compose');
    assert.equal(out.reprocessed, true);
    assert.equal(out.skipSend, false);
    assert.doesNotMatch(out.result.proposedResponse || '', /soap bubble/i);
  });

  it('mid-compose new GUEST message still reprocesses (Michael regression)', async () => {
    const newestFirst = [
      msg('guest', 'Thanks', '2026-08-21T18:40:43Z'),
      msg('guest', 'Richard popped in and helped', '2026-08-21T18:40:41Z'),
      msg('guest', 'All set', '2026-08-21T18:40:23Z'),
    ];
    let reprocessCalls = 0;
    const out = await runPreSendThreadRefresh({
      hospitableClient: {
        async getThreadMessages() {
          return newestFirst;
        },
      },
      reservationId: 'michael-res',
      originalGuestMessage: 'All set',
      originalResult: {
        typeOfMessageReceived: 'THANK_YOU_MESSAGE',
        proposedResponse: "You're welcome, Michael! See you soon.",
        shouldReply: true,
      },
      context: { guestName: 'Michael' },
      reprocess: async (latest, ctx) => {
        reprocessCalls += 1;
        assert.equal(latest, 'Thanks');
        assert.ok(ctx._preSendReprocessed);
        assert.deepEqual(ctx.preSendNewerGuestMessages, [
          'Richard popped in and helped',
          'Thanks',
        ]);
        return {
          typeOfMessageReceived: 'THANK_YOU_MESSAGE',
          proposedResponse: "You're welcome, Michael!",
          shouldReply: true,
        };
      },
    });
    assert.equal(reprocessCalls, 1);
    assert.equal(out.reprocessed, true);
    const chrono = chronologicalThread(newestFirst);
    assert.equal(guestMessagesAfter(chrono, 'All set').length, 2);
  });
});
