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
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HospitableClient } from '../src/clients/HospitableClient.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

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

  // Ensure we have the real Grok key (fetch from SSM /grok/api-key if not already in env)
  // This allows the harness to use the full multipass + Judge with real Grok,
  // matching production behavior from the old auto-reply-sqs Lambda.
  await getGrokApiKey();

  const agent = new GuestMessagingAgent({
    llm: process.env.GROK_API_KEY ? 'auto' : 'mock',
    notification: 'auto',

    // Conversation Judge (anti-repetition, consistency, and policy enforcement)
    // With only 4-5 messages per day, we run the judge on every message by default.
    // Set ENABLE_CONVERSATION_JUDGE=false only if you want to disable it.
    enableConversationJudge: process.env.ENABLE_CONVERSATION_JUDGE !== 'false',

    // Clients for UnitReadinessTool (used for unit readiness / early check-in logic)
    ddbClient,
    hospitableClient
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
