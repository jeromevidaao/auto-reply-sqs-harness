/**
 * AWS Lambda handler for the Guest Messaging Agent Harness.
 *
 * Production entrypoint. Supports:
 * - Direct/manual invoke: { message, context }
 * - Real SQS traffic from grok_message (the shapes the old monolithic system actually sends):
 *     { body: "<json-string>" }                 → often contains nested { data: { body, conversation_id, ... } }
 *     { data: { body, reservation_id, conversation_id, ... } }
 *
 * The extraction logic below is intentionally tolerant so we don't drop messages during the cutover.
 */

import { GuestMessagingAgent } from '../src/agent.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { HospitableClient } from '../src/clients/HospitableClient.js';
import { KumoCloudClient } from '../src/clients/KumoCloudClient.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SQSClient, CreateQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';

const ssm = new SSMClient({ region: 'us-east-1' });

let _grokKeyCache = null;

/**
 * Fetches the real xAI Grok API key.
 * Priority: process.env.GROK_API_KEY → SSM /grok/api-key (SecureString)
 *
 * This mirrors how the original auto-reply-sqs Lambda sourced its key
 * (env var at runtime, value stored in SSM as discovered from the old codebase).
 */
async function getGrokApiKey() {
  if (process.env.GROK_API_KEY) {
    return process.env.GROK_API_KEY;
  }
  if (_grokKeyCache) return _grokKeyCache;

  try {
    const command = new GetParameterCommand({
      Name: '/grok/api-key',
      WithDecryption: true
    });
    const response = await ssm.send(command);
    _grokKeyCache = response.Parameter.Value;
    // Also set it in process.env so the existing LLM adapter logic picks it up
    process.env.GROK_API_KEY = _grokKeyCache;
    return _grokKeyCache;
  } catch (err) {
    console.warn('[Handler] Could not fetch GROK_API_KEY from SSM /grok/api-key:', err.message);
    return null;
  }
}

/**
 * Fetches Google Maps API key (for get_travel_times / distance questions to Old Port etc.).
 * Priority: process.env.GOOGLE_MAPS_API_KEY → SSM /google/maps-api-key (SecureString)
 * Non-fatal: if missing the GoogleMapsTool will return sensible mock data.
 */
async function getGoogleMapsApiKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) {
    return process.env.GOOGLE_MAPS_API_KEY;
  }
  try {
    const command = new GetParameterCommand({
      Name: '/google/maps-api-key',
      WithDecryption: true
    });
    const response = await ssm.send(command);
    process.env.GOOGLE_MAPS_API_KEY = response.Parameter.Value;
    return response.Parameter.Value;
  } catch (err) {
    console.warn('[Handler] Could not fetch GOOGLE_MAPS_API_KEY from SSM /google/maps-api-key (will use mocks for distance questions):', err.message);
    return null;
  }
}

export const handler = async (event, context) => {
  const requestId = context?.awsRequestId || 'local-' + Date.now();
  const startTime = Date.now();

  // === RICH INVOCATION LOGGING ===
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`🚀 [${requestId}] Guest Messaging Harness INVOKED`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Timestamp:', new Date().toISOString());
  console.log('AWS Request ID:', context?.awsRequestId);
  console.log('Event Source:', event?.Records ? 'SQS' : 'Direct/Other');

  // Log full incoming event for deep debugging (CloudWatch searchable)
  console.log('RAW EVENT:', JSON.stringify(event, null, 2));

  // === ACT ROUTING ===
  // When invoked via API Gateway → SQS → Lambda, queryStringParameters are inside the SQS record body.
  let actPayload = event;
  if (event?.Records?.[0]?.body) {
    try { actPayload = JSON.parse(event.Records[0].body); } catch { /* ignore */ }
  }
  const act = actPayload?.queryStringParameters?.act || event?.queryStringParameters?.act;

  if (act === 'new_reservation_home_exchange') {
    const sqs = new SQSClient({ region: 'us-east-1' });
    const queueName = `home-exchange-reservation-${Date.now()}`;

    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));

    await sqs.send(new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(actPayload),
    }));

    console.log(`[act:new_reservation_home_exchange] Created queue ${queueName} and pushed payload`);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, act, queueName, queueUrl: QueueUrl }),
    };
  }

  // Print the raw SQS message body explicitly for easy reference when debugging
  // extraction / parsing issues (very useful during cutover and when real webhooks arrive).
  if (event?.Records?.[0]?.body) {
    console.log('RAW SQS MESSAGE BODY (exact string received from queue):', event.Records[0].body);
  }

  // === Robust extraction for both direct invokes and real SQS traffic ===
  // Real production messages (from the old system / Hospitable webhooks) often arrive
  // with shapes like:
  //   { body: "<json-string>" }                          → inner may contain .data.body
  //   { data: { body: "...", reservation_id, conversation_id, ... } }
  // This helper tries the most common shapes so we don't lose messages during cutover.
  function extractMessageAndContext(evt) {
    // Direct / simulator style
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

    // Shape used by the old monolithic Lambda: { body: "<json-string-of-webhook>" }
    if (typeof outer.body === 'string') {
      try {
        const inner = JSON.parse(outer.body);
        if (inner?.data) {
          return {
            message: inner.data.body || inner.data.message || '',
            context: {
              ...inner.data,
              reservationId: inner.data.reservation_id || inner.data.id,
              conversation_id: inner.data.conversation_id || inner.data.airbnb_conversation_id,
              sender_type: inner.data.sender_type || inner.data.sender?.type,
              sender: inner.data.sender || { type: inner.data.sender_type },
              // Preserve raw top-level webhook id for dedup (e.g. "a1e74780-...")
              _webhookId: inner.id || null,
              // Preserve action/triggers for reaction update detection etc.
              action: inner.action || null,
              triggers: inner.triggers || null,
            }
          };
        }
        return {
          message: inner.body || inner.message || '',
          context: inner
        };
      } catch {
        // fall through
      }
    }

    // Cleaner shape we also support: top-level { data: { body, ... } }
    if (outer.data) {
      return {
        message: outer.data.body || outer.data.message || '',
        context: {
          ...outer.data,
          reservationId: outer.data.reservation_id || outer.data.id,
          conversation_id: outer.data.conversation_id || outer.data.airbnb_conversation_id,
          sender_type: outer.data.sender_type || outer.data.sender?.type,
          sender: outer.data.sender || { type: outer.data.sender_type },
          _webhookId: outer.id || null,
          // Preserve action/triggers for reaction update detection etc.
          action: outer.action || null,
          triggers: outer.triggers || null,
        }
      };
    }

    // Fallback
    return {
      message: outer.body || outer.message || '',
      context: outer
    };
  }

  const extracted = extractMessageAndContext(event);
  const guestMessage = extracted.message;
  const msgContext = { ...extracted.context, ...(event?.context || {}), ...(event?.payload?.context || {}) };

  // Enrich guest name for greeting + personalization.
  // Prod webhooks (message.created etc) reliably include sender.first_name / full_name on guest messages.
  // Reservation/inquiry shapes may have guest or guestName. Ensure we always surface a usable guestName
  // so that handleMessage can normalize to guestDisplayName and the greeting logic + prompt can use "Amy," etc.
  const extractedGuestName =
    msgContext.guestName ||
    msgContext.guest?.first_name ||
    msgContext.guest?.full_name ||
    msgContext.sender?.first_name ||
    msgContext.sender?.full_name ||
    (typeof msgContext.sender === 'string' ? msgContext.sender : null) ||
    msgContext.guest_name ||
    null;
  if (extractedGuestName && !msgContext.guestName) {
    msgContext.guestName = extractedGuestName;
  }

  // === Early enrichment from full reservation details (for reliable petCount, checkIn/Out, listing on NEW_RESERVATION_WELCOME etc) ===
  // Message webhooks after booking often lack the full guests.pet_count etc that reservation.created provided in the old system.
  // Fetching here ensures the agent + welcome logic has accurate hasPets/petCount for the critical pet fee mismatch rules.
  const reservationIdForEnrich = msgContext.reservationId || msgContext.reservation_id || msgContext.reservation?.id;
  if (reservationIdForEnrich) {
    try {
      const enrichClient = new HospitableClient();
      const fullRes = await enrichClient.getReservation(reservationIdForEnrich).catch((e) => {
        console.warn('[Handler] Reservation enrichment fetch failed (non-fatal):', e?.message || e);
        return null;
      });
      if (fullRes) {
        if (!msgContext.checkIn && fullRes.check_in) msgContext.checkIn = fullRes.check_in;
        if (!msgContext.checkOut && fullRes.check_out) msgContext.checkOut = fullRes.check_out;
        if (fullRes.guests) {
          const pc = Number(fullRes.guests.pet_count || 0);
          if (msgContext.hasPets == null) msgContext.hasPets = pc > 0;
          if (msgContext.petCount == null) msgContext.petCount = pc;
        }
        if (fullRes.properties?.[0]) {
          if (!msgContext.listingId) msgContext.listingId = fullRes.properties[0].id;
          if (!msgContext.propertyName) msgContext.propertyName = fullRes.properties[0].name;
        }
        if (fullRes.arrival_date && !msgContext.checkIn) msgContext.checkIn = fullRes.arrival_date; // some shapes
        if (fullRes.departure_date && !msgContext.checkOut) msgContext.checkOut = fullRes.departure_date;
        console.log('[Handler] Enriched msgContext from reservation details (pet/dates/listing for welcome & pet logic)');
      }
    } catch (e) {
      console.warn('[Handler] Early reservation enrichment skipped (non-fatal):', e?.message || e);
    }
  }

  // === ALWAYS log full sender diagnostics for debugging classification issues ===
  // Per instruction: host vs guest classification must be based ONLY on sender metadata,
  // never on message content/body.
  console.log('🔍 SENDER DIAGNOSTICS:', JSON.stringify({
    sender_type: msgContext.sender_type || msgContext.sender?.type,
    sender_role: msgContext.sender_role || msgContext.sender?.role,
    sender_full_name: msgContext.sender?.full_name || msgContext.sender?.name,
    sender_id: msgContext.sender?.id || msgContext.sender?.user_id,
    user_name: msgContext.user?.name,   // account owner context only (for diagnostics)
    source: msgContext.source,
    _webhookId: msgContext._webhookId,
    action: msgContext.action,
    triggers: msgContext.triggers,
  }, null, 2));

  // === Host / Guest classification for the *current incoming message* ===
  // RULE: Use ONLY explicit information provided in the sender object itself.
  //        Never use message body/content, never use the top-level "user" (account owner) as a proxy.
  //        sender_type / sender.type / sender_role / sender.role are the authoritative signals.
  const senderType = (msgContext.sender_type || msgContext.sender?.type || msgContext.from?.type || '').toLowerCase().trim();
  const senderRole = (msgContext.sender_role || msgContext.sender?.role || '').toLowerCase().trim();

  // Explicit signals from the sender metadata
  const isSenderExplicitlyHost = senderType === 'host' || senderRole === 'host';
  const isSenderExplicitlyGuest = senderType === 'guest' || senderRole === 'guest';

  // Final decision: only treat as host message if the sender metadata itself says it is from the host.
  // If the sender explicitly says "guest", we must respect that (even if the name happens to look like the host).
  const isDefinitelyHost = isSenderExplicitlyHost;

  if (isDefinitelyHost) {
    console.log(`[Handler] ⛔ Ignoring host message (sender_type=${senderType || 'n/a'}, role=${senderRole || 'n/a'}, source=${msgContext.source}). Never reply to host.`);
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, reason: 'Host message (sender metadata only)' })
    };
  }

  // Skip "message.updated" events that are purely host reaction additions (e.g. manual thumbs up on a guest message).
  // These are not new guest content; the guest message was already (or will be) handled via its .created event.
  // Without this, Hospitable emits both "message.created" and "message.updated" (with triggers:["reaction_added"])
  // for the same guest text + host reaction, leading to duplicate auto-replies (e.g. double "You're welcome").
  const action = msgContext.action || null;
  const triggers = Array.isArray(msgContext.triggers) ? msgContext.triggers : (msgContext.triggers ? [msgContext.triggers] : []);
  if (action === 'message.updated' && triggers.includes('reaction_added')) {
    console.log(`[Handler] ⛔ Ignoring message.updated with reaction_added (host manually reacted to guest message; not new input for auto-reply).`);
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, reason: 'reaction_added update' })
    };
  }

  // Optional: very old payloads with zero sender_type information at all.
  // In this extremely rare case we log a warning but do NOT use content heuristics.
  // We let the message proceed to the agent (which has its own lighter defense-in-depth check).
  if (!senderType && !senderRole) {
    console.log(`[Handler] ⚠️ No sender_type or sender.role present in payload. Proceeding to agent (no content-based host heuristics are used).`);
  }

  // (Dedup check moved below after ddbClient is initialized for reuse)

  console.log('\n📋 RESERVATION / INQUIRY DETAILS:');
  console.log(JSON.stringify({
    guestName: msgContext.guestName || msgContext.guest?.first_name,
    listingId: msgContext.listingId || msgContext.properties?.[0]?.id,
    propertyName: msgContext.propertyName || msgContext.properties?.[0]?.name,
    checkIn: msgContext.checkIn || msgContext.check_in,
    checkOut: msgContext.checkOut || msgContext.check_out,
    bookingDate: msgContext.bookingDate,
    hasPets: msgContext.hasPets,
    petCount: msgContext.petCount,
    conversation_id: msgContext.conversation_id,
    airbnb_conversation_id: msgContext.airbnb_conversation_id,
    reservationId: msgContext.reservationId || msgContext.reservation_id,
    sender_type: msgContext.sender_type || msgContext.sender?.type,
    action: msgContext.action,
    triggers: msgContext.triggers,
  }, null, 2));

  console.log('\n💬 GUEST MESSAGE:');
  console.log(guestMessage);

  if (!guestMessage) {
    console.error('❌ No guest message found in event');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'No message provided' }),
    };
  }

  // === Clients for UnitReadinessTool ===
  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
  const hospitableClient = new HospitableClient();
  const kumoClient = new KumoCloudClient();

  // === Idempotency / Dedup using DynamoDB (prevents double sends from SQS redeliveries + duplicate webhooks) ===
  // Uses the stable top-level webhook "id" from the Hospitable payload.
  // Additionally, when a platform message id is present (data.id / platform_id), we dedup on the
  // *guest message itself* (composite key). This catches the case where Hospitable emits two distinct
  // events for the same guest communication: "message.created" + "message.updated" (e.g. when host adds
  // a reaction like thumbs up shortly after the guest sends "thank you"). Both events carry the same
  // guest body and message id, so without message-level dedup we process the guest text twice and send
  // duplicate "You're welcome" acks. Webhook id alone is not sufficient (different event ids).
  const webhookIdForDedup = msgContext._webhookId || msgContext.id || null;
  // Prefer a stable message identifier for the *guest content* (platform_id or the inner data.id for the message).
  // This is present on both "message.created" and "message.updated" events for the same guest text,
  // allowing us to dedup across the multiple events Hospitable emits for one guest message + host reaction.
  const messagePlatformId = msgContext.platform_id || (msgContext.id && typeof msgContext.id === 'string' && !msgContext.id.includes('-') ? msgContext.id : (typeof msgContext.id === 'number' ? msgContext.id : null));
  const convForDedup = msgContext.conversation_id || msgContext.conversationId || msgContext.reservation_id || msgContext.reservationId || null;
  let dedupKey = webhookIdForDedup;
  if (messagePlatformId && convForDedup) {
    dedupKey = `guestmsg:${convForDedup}:${messagePlatformId}`;
  }
  if (dedupKey) {
    try {
      const ttl = Math.floor(Date.now() / 1000) + (2 * 60 * 60); // 2h TTL
      await ddbClient.send(new PutCommand({
        TableName: 'airbnb-harness-dedup',
        Item: {
          webhookId: dedupKey,
          ttl,
          processedAt: new Date().toISOString(),
          reservationId: msgContext.reservationId || msgContext.reservation_id || null
        },
        ConditionExpression: 'attribute_not_exists(webhookId)'
      }));
      console.log(`[Handler] Dedup: dedupKey ${dedupKey} recorded (first processing)`);
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') {
        console.log(`[Handler] ⛔ DEDUP SKIP: dedupKey ${dedupKey} already processed (SQS redelivery / duplicate webhook / duplicate guest message event (created+updated) protection)`);
        return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'Duplicate webhook or guest message (dedup)' }) };
      }
      console.warn('[Handler] Dedup check non-fatal (proceeding):', e.message);
    }
  }

  // Ensure we have the real Grok key (fetch from SSM /grok/api-key if not already in env)
  // Mock LLM is no longer supported at all (even for tests).
  await getGrokApiKey();

  if (!process.env.GROK_API_KEY) {
    throw new Error('GROK_API_KEY is required. Mock LLM is disabled.');
  }

  // Optional: Google Maps key for live distance / Old Port / walk-drive answers (used by GoogleMapsTool).
  // Falls back gracefully to mock data if missing (same pattern as old monolithic Lambda).
  await getGoogleMapsApiKey();

  // Reflection is now always enabled in production.
  // This ensures the complete pipeline (Main LLM → Tools → Reflection → Judge) runs on every message.
  const agent = new GuestMessagingAgent({
    llm: 'auto',
    notification: 'auto',

    // Reflection (second-pass critique) is now always on in production.
    // This ensures the full multipass pipeline (Main LLM → Tools → Reflection → Judge) runs on every message.
    enableReflection: true,
    reflectionCategories: [
      'CANCELLATION_POLICY',
      'CANCELLATION_NOTIFICATION',
      'CANCELLATION_POLICY_EXCEPTION',
      'NEW_RESERVATION_WELCOME',
      'NEW_INQUIRY_WELCOME',
      'GENERAL_ACKNOWLEDGMENT',   // common short "thanks / okay perfect" replies — now fully reflected for safety
      'OTHER_MESSAGE'   // include generic messages so the full pipeline (including Reflection) is exercised on "other" traffic
    ],

    // Conversation Judge (anti-repetition, consistency, and policy enforcement)
    // With only 4-5 messages per day, we run the judge on every message by default.
    // Set ENABLE_CONVERSATION_JUDGE=false only if you want to disable it.
    enableConversationJudge: process.env.ENABLE_CONVERSATION_JUDGE !== 'false',

    // Clients for UnitReadinessTool (used for unit readiness / early check-in logic)
    ddbClient,
    hospitableClient,
    kumoClient
  });


  try {
    const result = await agent.handleMessage(guestMessage, msgContext);
    const duration = Date.now() - startTime;

    // === DETAILED DECISION + TOOL TRACING ===
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`📊 [${requestId}] AGENT DECISION + TRACE (took ${duration}ms)`);
    console.log('═══════════════════════════════════════════════════════════════');

    console.log('Decision Summary:', {
      typeOfMessageReceived: result.typeOfMessageReceived,
      shouldReply: result.shouldReply,
      proposedResponseLength: result.proposedResponse?.length || 0,
      escalated: result.escalated,
      cleaningIssueDetected: result.cleaningIssueDetected,
      hasThermostatInfo: !!result.thermostatInfo,
      hasHeatPumpInfo: !!result.heatPumpInfo,
      hasCancellationInfo: !!result.cancellationInfo,
      hasEventInfo: !!result.eventInfo,
    });

    // Log tool results in detail (very useful for debugging)
    if (result.cleaningIssueDetected && result.cleaningIssue) {
      console.log('🧹 CLEANING ISSUE DETECTED:', JSON.stringify(result.cleaningIssue, null, 2));
    }
    if (result.thermostatInfo) {
      console.log('🌡️  THERMOSTAT INFO:', JSON.stringify(result.thermostatInfo, null, 2));
    }
    if (result.heatPumpInfo) {
      const hp = result.heatPumpInfo;
      const fixed = hp.actionTaken?.fixed ? ' (AUTO-FIXED units)' : '';
      console.log('🔥  HEAT PUMP LIVE STATUS' + fixed + ':', JSON.stringify({
        detected: hp.detected,
        action: hp.actionTaken ? { fixed: hp.actionTaken.fixed, mode: hp.actionTaken.recommendedMode, tempF: hp.actionTaken.recommendedTempF } : null,
        summary: hp.liveStatus?.summary,
        unitCount: hp.liveStatus?.unitCount
      }, null, 2));
    }
    if (result.cancellationInfo) {
      console.log('📋 CANCELLATION INFO:', JSON.stringify(result.cancellationInfo, null, 2));
      if (result.cancellationInfo.officialPolicyUrl) {
        console.log('🔗 Official Airbnb Policy Link:', result.cancellationInfo.officialPolicyUrl);
      }
      if (result.cancellationInfo.policy?.officialUrl) {
        console.log('🔗 Policy snapshot used:', result.cancellationInfo.policy.officialUrl);
      }
    }
    if (result.eventInfo) {
      console.log('🎉 EVENT REQUEST INFO:', JSON.stringify(result.eventInfo, null, 2));
    }

    // Log urgent access SMS escalations (very high priority)
    if (result.urgentAccessNotified) {
      console.log('🚨🚨 URGENT ACCESS SMS SENT:', JSON.stringify(result.urgentAccessNotified, null, 2));
    }

    // Log reflection result if it ran
    if (result.reflection) {
      console.log('🔍 REFLECTION RESULT:', JSON.stringify(result.reflection, null, 2));
      if (result.reflectionNotes) {
        console.log('🔍 Reflection notes:', result.reflectionNotes);
      }
    }

    // Log Conversation Judge result (new anti-repetition system)
    if (result.conversationJudge) {
      console.log('🧠 CONVERSATION JUDGE RESULT:', JSON.stringify(result.conversationJudge, null, 2));
      if (result.judgeNotes) {
        console.log('🧠 Judge notes:', result.judgeNotes);
      }
    }

    // === CRITICAL: LOG THE ACTUAL MESSAGE THAT WAS / WOULD BE SENT ===
    console.log('\n📤 FINAL MESSAGE / RESPONSE:');
    console.log('Type:', result.typeOfMessageReceived);
    console.log('Should Reply:', result.shouldReply);
    console.log('Proposed Response:');
    console.log(result.proposedResponse || '(none)');

    if (result.escalated) {
      console.log('\n🚨 ESCALATION TRIGGERED - Manual intervention required');
    }

    // === Actually send the reply to the guest ===
    // The original working auto-reply-sqs used the reservations endpoint.
    // We prefer that when we have a reservationId (more reliable with current token).
    if (result.shouldReply && result.proposedResponse && result.proposedResponse !== 'none' && !result.escalated) {
      const reservationId = msgContext.reservationId || msgContext.reservation_id || msgContext.reservation?.id;
      const convId = msgContext.conversation_id || msgContext.airbnb_conversation_id;

      const targetId = reservationId || convId;
      const targetType = reservationId ? 'reservation' : 'conversation';

      if (targetId) {
        const sentPreview = result.proposedResponse.substring(0, 80);

        // === Pre-send guard: prevent sending duplicate short replies (e.g. "You're welcome!" twice) ===
        try {
          const verifyConvForGuard = convId || (reservationId ? await hospitableClient.getConversationIdForReservation(reservationId).catch(() => null) : null);
          if (verifyConvForGuard) {
            const recent = await hospitableClient.getConversationMessages(verifyConvForGuard, 4);
            const veryRecentHostReplies = recent
              .filter(m => (m.sender_type === 'host' || m.sender?.type === 'host'))
              .slice(0, 3)
              .map(m => (m.body || '').trim().toLowerCase());

            const proposedLower = result.proposedResponse.trim().toLowerCase();
            const isDuplicateShortReply = veryRecentHostReplies.some(r =>
              r === proposedLower ||
              (proposedLower.includes("you're welcome") && r.includes("you're welcome")) ||
              (proposedLower.length < 40 && r === proposedLower)
            );

            if (isDuplicateShortReply) {
              console.log(`[Handler] ⛔ PRE-SEND GUARD: Skipping send — identical or "You're welcome" style reply already sent very recently to this conversation.`);
              console.log('   Recent host replies:', veryRecentHostReplies);
              // Treat as success (no escalation needed)
              return {
                statusCode: 200,
                body: JSON.stringify({ success: true, skipped: true, reason: 'Pre-send duplicate guard' })
              };
            }
          }
        } catch (guardErr) {
          console.warn('[Handler] Pre-send duplicate guard non-fatal error (proceeding with send):', guardErr.message);
        }

        console.log(`📤 SENDING REPLY → ${targetType}:`, targetId, '| preview:', sentPreview);

        try {
          // === Actual send (this is the critical operation) ===
          if (reservationId) {
            await hospitableClient.sendMessageToReservation(reservationId, result.proposedResponse);
          } else {
            await hospitableClient.sendMessage(convId, result.proposedResponse);
          }
          console.log('✅ Reply successfully sent to guest via Hospitable');

          // === Verification (best-effort only — never a hard failure) ===
          // A 404 or missing message here is usually just eventual consistency.
          // The actual send already succeeded, so we treat verification problems as warnings.
          try {
            await new Promise(resolve => setTimeout(resolve, 3000)); // slightly longer sleep for consistency

            // Resolve conversation_id if we only have reservationId
            let verifyConvId = convId;
            if (!verifyConvId && reservationId) {
              try {
                verifyConvId = await hospitableClient.getConversationIdForReservation(reservationId);
              } catch (e) {
                console.warn('[Handler] Could not resolve conversation_id for verification:', e.message);
              }
            }

            if (!verifyConvId) {
              console.warn('⚠️ No conversation_id available for post-send verification (send itself succeeded).');
            } else {
              const recentMessages = await hospitableClient.getConversationMessages(verifyConvId, 5);
              const latestMessage = recentMessages[0];

              if (latestMessage && latestMessage.body && latestMessage.body.includes(sentPreview)) {
                console.log('✅ Verification successful: The reply appears in recent messages.');
              } else {
                const recentPreviews = recentMessages.map(m => ({
                  sender_type: m.sender_type,
                  body_preview: m.body?.substring(0, 100)
                }));
                console.warn('⚠️ Verification could not yet confirm the sent message (eventual consistency or timing).');
                console.warn('   Sent preview:', sentPreview);
                console.warn('   Recent messages:', JSON.stringify(recentPreviews, null, 2));
              }
            }
          } catch (verifyErr) {
            // Never let verification errors cause a hard Lambda failure
            console.warn('⚠️ Post-send verification step encountered an error (non-critical):', verifyErr.message);
          }

        } catch (sendError) {
          // Only actual send failures are hard failures
          console.error('❌ HARD FAILURE: Failed to send reply to guest:', sendError.message);
          throw new Error(`Failed to deliver message to guest: ${sendError.message}`);
        }
      } else {
        const errMsg = 'Cannot send reply: no reservationId or conversation_id present in message context.';
        console.error('❌ HARD FAILURE:', errMsg);
        throw new Error(errMsg);
      }
    } else if (result.shouldReply === false && !result.escalated) {
      console.log('ℹ️ Decision was to not reply (no message sent).');
    }

    console.log('\n⏱️  Total handler duration:', duration, 'ms');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Return rich response for manual invokes (full trace is in CloudWatch anyway)
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        requestId,
        decision: {
          typeOfMessageReceived: result.typeOfMessageReceived,
          proposedResponse: result.proposedResponse,
          shouldReply: result.shouldReply,
          escalated: result.escalated,
          cleaningIssueDetected: result.cleaningIssueDetected,
        },
        tools: {
          cleaning: result.cleaningIssueDetected ? result.cleaningIssue : null,
          thermostat: result.thermostatInfo,
          heatPump: result.heatPumpInfo,
          cancellation: result.cancellationInfo,
          event: result.eventInfo,
        },
        reflection: result.reflection || null,
        conversationJudge: result.conversationJudge || null,
        fullResult: result, // Keep full object for deep debugging
      }),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    // Critical Hospitable failures (after retries) must cause a hard Lambda failure
    // so SQS can retry or send to DLQ, and alarms can trigger.
    if (error.name === 'CriticalHospitableError' || error.message.includes('CRITICAL HOSPITABLE')) {
      console.error('\n🚨🚨 CRITICAL HOSPITABLE FAILURE (after retries) — HARD LAMBDA FAILURE');
      console.error('Operation:', error.operation);
      console.error('Attempts:', error.attempts);
      console.error('Error:', error.message);
      console.error('Stack:', error.stack);
      console.error('Failed Context:', JSON.stringify(msgContext, null, 2));

      // Re-throw so the Lambda invocation is marked as failed (important for SQS + DLQ)
      throw error;
    }

    console.error('\n❌ [${requestId}] HARNESS CRITICAL ERROR after', duration, 'ms');
    console.error('Error:', error);
    console.error('Stack:', error.stack);

    // Log context that failed for easier debugging
    console.error('Failed Context:', JSON.stringify(msgContext, null, 2));

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        requestId,
        error: error.message,
        stack: error.stack,
      }),
    };
  }
};
