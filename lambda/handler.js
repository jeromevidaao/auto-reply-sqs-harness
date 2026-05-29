/**
 * AWS Lambda handler for the Guest Messaging Agent Harness.
 *
 * This is the production entrypoint for the harness logic.
 * It can be invoked manually for testing (no trigger attached yet).
 *
 * Expected event shape for manual testing:
 * {
 *   "message": "the guest message text",
 *   "context": {
 *     "guestName": "Josh",
 *     "checkIn": "2026-05-25",
 *     "checkOut": "2026-05-27",
 *     "listingId": "...",
 *     "propertyName": "...",
 *     "airbnb_conversation_id": "2492335251",
 *     ...
 *   }
 * }
 *
 * Environment variables for urgent access (guest cannot get in):
 *   URGENT_ACCESS_SNS_TOPIC_ARN     (preferred - supports multiple SMS recipients)
 *   URGENT_ACCESS_PHONE_NUMBER      (comma-separated, e.g. +16462043958,+15086676477)
 */

import { GuestMessagingAgent } from '../src/agent.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HospitableClient } from '../src/clients/HospitableClient.js';

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

  // Extract key context for easy filtering in CloudWatch Logs Insights
  const guestMessage = event?.message || event?.body || (event?.Records?.[0]?.body ? JSON.parse(event.Records[0].body).data?.body : '');
  const msgContext = event?.context || event?.payload?.context || {};

  console.log('\n📋 RESERVATION / INQUIRY DETAILS:');
  console.log(JSON.stringify({
    guestName: msgContext.guestName,
    listingId: msgContext.listingId,
    propertyName: msgContext.propertyName,
    checkIn: msgContext.checkIn,
    checkOut: msgContext.checkOut,
    bookingDate: msgContext.bookingDate,
    hasPets: msgContext.hasPets,
    petCount: msgContext.petCount,
    airbnb_conversation_id: msgContext.airbnb_conversation_id,
    reservationId: msgContext.reservationId || event?.Records?.[0]?.body ? JSON.parse(event.Records[0].body).data?.reservation_id : null,
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
