#!/usr/bin/env node
/**
 * Replay the EXACT latest SQS payload from CloudWatch logs (the one after
 * "just sent 3 more just now").
 *
 * We iterate locally (edit + run) until the flow produces a send decision
 * (the 📤 SENDING REPLY line) for this real production payload.
 *
 * Current payload: the most recent one captured right after the user's
 * latest 3 messages (host-shaped "Good morning Eve..." with sender_type host).
 */

import { GuestMessagingAgent } from '../src/agent.js';
import { createLLMAdapter } from '../src/adapters/llm/index.js';

// ======================================================================
// EXACT extractMessageAndContext logic (same as lambda/handler.js)
// ======================================================================
function extractMessageAndContext(evt) {
  if (evt?.message) return { message: evt.message, context: evt.context || {} };
  if (evt?.body && typeof evt.body === 'string' && !evt.Records) {
    return { message: evt.body, context: evt.context || {} };
  }

  const record = evt?.Records?.[0];
  if (!record?.body) {
    return { message: '', context: {} };
  }

  let outer;
  try {
    outer = JSON.parse(record.body);
  } catch {
    return { message: record.body, context: {} };
  }

  if (typeof outer.body === 'string') {
    try {
      const inner = JSON.parse(outer.body);
      if (inner?.data) {
        return {
          message: inner.data.body || inner.data.message || '',
          context: {
            ...inner.data,
            reservationId: inner.data.reservation_id || null,
            conversation_id: inner.data.conversation_id || inner.data.airbnb_conversation_id,
            sender_type: inner.data.sender_type || inner.data.sender?.type,
            sender: inner.data.sender || { type: inner.data.sender_type },
          }
        };
      }
      return {
        message: inner.body || inner.message || '',
        context: inner
      };
    } catch {}
  }

  if (outer.data) {
    return {
      message: outer.data.body || outer.data.message || '',
      context: {
        ...outer.data,
        reservationId: outer.data.reservation_id || null,
        conversation_id: outer.data.conversation_id || outer.data.airbnb_conversation_id,
        sender_type: outer.data.sender_type || outer.data.sender?.type,
        sender: outer.data.sender || { type: outer.data.sender_type },
      }
    };
  }

  return {
    message: outer.body || outer.message || '',
    context: outer
  };
}

// ======================================================================
// EXACT latest SQS payload from CloudWatch (captured immediately after
// the user said "just sent 3 more just now" — 14:19 UTC window).
// This is the real production shape that hit the Lambda.
// ======================================================================
const latestRealSqsEvent = {
  Records: [
    {
      body: JSON.stringify({
        resource: "/helloworld",
        path: "/helloworld",
        httpMethod: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Host: "g32pkusnye.execute-api.us-east-1.amazonaws.com",
          "User-Agent": "Hospitable",
          "X-Forwarded-For": "38.80.170.47",
          "X-Forwarded-Port": "443",
          "X-Forwarded-Proto": "https"
        },
        queryStringParameters: { act: "message", jwt: "..." },
        body: JSON.stringify({
          id: "a1e55a46-e33c-4f53-8f32-c28f30d39671",
          data: {
            id: 1205271185,
            body: "Good morning Eve, \n\nI hope that you have settled in after your travel and that you are enjoying your stay. Please let me know if there is anything you need or if I can assist you in any way! Don't forget to take advantage of the hard copy of my Portland guidebook at the place.\n\nAll the best and enjoy all that Portland has to offer!\n\nJerome & Ruby",
            user: {
              id: "436eb2ed-5174-5542-926f-5013bae34188",
              name: "Jerome Ansia",
              email: "jerome.ans@gmail.com",
              profile_picture: "https://a0.muscache.com/im/pictures/user/1a21e083-db60-4296-9d97-f3c210294bea.jpg"
            },
            sender: {
              locale: "",
              location: "",
              full_name: "Jerome Ansia",
              first_name: "Jerome",
              picture_url: "https://a0.muscache.com/im/pictures/user/1a21e083-db60-4296-9d97-f3c210294bea.jpg"
            },
            source: "automated",
            listing: { platform: "airbnb", platform_id: "20904545" },
            platform: "airbnb",
            property: {
              id: "c899481f-2e5b-402d-80c4-3167fd824d96",
              name: "Downtown Studio, Walk Everywhere, Parking",
              public_name: "Downtown Studio, Parking with EV charger"
            },
            reactions: [],
            created_at: "2026-05-29T14:00:14Z",
            attachments: [],
            integration: null,
            platform_id: "30995174778",
            sender_role: "host",
            sender_type: "host",
            content_type: "text/plain",
            reservation_id: "3bcde6bd-3b03-44c4-b9b3-f5b785366160",
            conversation_id: "d92904d5-7850-4fbb-ac50-f6982ad405b4",
            sent_reference_id: null
          },
          action: "message.created",
          created: "2026-05-29T14:19:01Z",
          version: "v2",
          triggers: []
        }),
        isBase64Encoded: false
      })
    }
  ]
};

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 LOCAL REPLAY — EXACT latest SQS payload from CloudWatch');
  console.log('   (Captured right after user said "just sent 3 more just now")');
  console.log('   We will iterate this script + any necessary fixes until');
  console.log('   the flow produces a send (📤 SENDING REPLY line).');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const extracted = extractMessageAndContext(latestRealSqsEvent);
  const guestMessage = extracted.message;
  const msgContext = { ...extracted.context };

  console.log('📥 EXTRACTED FROM LATEST REAL SQS PAYLOAD:');
  console.log('   guestMessage (first 100 chars):', JSON.stringify(guestMessage.substring(0,100)));
  console.log('   sender_type:', msgContext.sender_type);
  console.log('   conversation_id:', msgContext.conversation_id);
  console.log('');

  // Sender guard (identical to production handler)
  const senderType = (msgContext.sender_type || msgContext.sender?.type || '').toLowerCase();
  if (senderType && senderType !== 'guest') {
    console.log('⛔ Guard: non-guest (sender_type:', senderType, ') — early return, no agent, no send.');
    console.log('   This matches exactly what is happening in production logs for the latest messages.');
    console.log('');
    console.log('   To force the rest of the pipeline for debugging, we will continue anyway...');
    console.log('');
  } else {
    console.log('✅ Passed sender_type guard\n');
  }

  // Run the agent anyway (to see what decision it would make if the guard wasn't there)
  const llm = createLLMAdapter('auto');
  const agent = new GuestMessagingAgent({
    llmAdapter: llm,
    enableReflection: true,
    reflectionCategories: [
      'CANCELLATION_POLICY',
      'CANCELLATION_NOTIFICATION',
      'CANCELLATION_POLICY_EXCEPTION',
      'NEW_RESERVATION_WELCOME',
      'NEW_INQUIRY_WELCOME',
      'GENERAL_ACKNOWLEDGMENT',
      'OTHER_MESSAGE'
    ],
    enableConversationJudge: true
  });

  console.log('🤖 Running agent on the extracted message from the latest real payload...\n');
  const result = await agent.handleMessage(guestMessage, msgContext);

  console.log('📊 AGENT DECISION (what the model produced for this payload):');
  console.log('   typeOfMessageReceived:', result.typeOfMessageReceived);
  console.log('   shouldReply:', result.shouldReply);
  console.log('   proposedResponse:', result.proposedResponse);
  console.log('   escalated:', result.escalated);
  console.log('');

  // Simulate the send block (the part the user cares about)
  if (result.shouldReply && result.proposedResponse && result.proposedResponse !== 'none' && !result.escalated) {
    const convId = msgContext.conversation_id || msgContext.airbnb_conversation_id;
    if (convId) {
      const sentPreview = result.proposedResponse.substring(0, 80);
      console.log('📤 SENDING REPLY → conversation_id:', convId, '| preview:', sentPreview);
      console.log('   ✅ This payload would have triggered a real send in production.');
    }
  } else {
    console.log('ℹ️ No send for this payload (either guard blocked it or agent decided not to reply).');
  }

  console.log('\n✅ Local run complete for the exact latest SQS payload from the logs.');
  console.log('   If this is a host-shaped message, the guard correctly prevents sending.');
  console.log('   Compare this to the earlier Valentina guest payload (which did reach the send block).');
}

main().catch(err => {
  console.error('Replay crashed:', err);
  process.exit(1);
});