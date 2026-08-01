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
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { loadHostContacts } from '../src/config/hostContacts.js';
import { notifyOwnerAndroid, clip } from '../src/adapters/notification/fcm.js';

const ssm = new SSMClient({ region: 'us-east-1' });
const sns = new SNSClient({ region: 'us-east-1' });

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
  //
  // Important: Inquiries (and some message.created events) legitimately have no reservation_id,
  // only conversation_id. We must never fall back to the numeric message platform id (data.id).
  // We explicitly compute isInquiry later and route to conversation-based send + tools.
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
              reservationId: inner.data.reservation_id || null,
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
          reservationId: outer.data.reservation_id || null,
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

  // Helper: infer pet count when structured data (webhook + /inquiries) is missing but the guest
  // explicitly declares pets in their message. This covers real-world cases like the Nicole inquiry
  // where the UI showed "2 guests, 2 pets" but neither the webhook data nor the getInquiryDetails
  // response included guests.pet_count.
  function inferPetCountFromMessage(text) {
    if (!text || typeof text !== 'string') return 0;
    const lower = text.toLowerCase();
    if (!/(dog|dogs|pet|pets|cat|cats|puppy|puppies|animal|animals)/.test(lower)) return 0;

    // Try explicit number + pet word
    const numMatch = lower.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(dog|dogs|pet|pets|cat|cats|puppy|puppies)/);
    if (numMatch) {
      const word = numMatch[1];
      const num = parseInt(word, 10) || ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }[word] || 1);
      return Math.min(Math.max(num, 1), 2); // respect max 2 pets policy
    }
    return 1; // at least one pet declared
  }

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

  // === Normalize pet/guest count directly from common webhook payload shapes (res + inquiry) ===
  // Inquiry webhooks (invite sent, pre-booking message.created) and some reservation events include
  // guests.pet_count (or equivalent) at the data level. Without normalization here the agent sees
  // undefined → defaults to hasPets:false / count:0 in _buildUserPrompt and welcome logic then
  // incorrectly emits the "add the pets to your reservation" mismatch text even when guest selected pets.
  if (msgContext.petCount == null && msgContext.pet_count != null) {
    msgContext.petCount = Number(msgContext.pet_count) || 0;
    if (msgContext.hasPets == null) msgContext.hasPets = msgContext.petCount > 0;
  }
  if (msgContext.hasPets == null && msgContext.has_pets != null) {
    msgContext.hasPets = !!msgContext.has_pets;
  }
  if (msgContext.guests) {
    const g = msgContext.guests;
    const pc = Number(g.pet_count || g.pets || g.petCount || g.number_of_pets || 0);
    if (msgContext.petCount == null && pc > 0) {
      msgContext.petCount = pc;
    }
    if (msgContext.hasPets == null) {
      msgContext.hasPets = (pc > 0) || !!g.has_pets;
    }
    if (msgContext.petCount == null && pc === 0) {
      msgContext.petCount = 0;
    }
    // Also capture infant/child counts for proactive pack-and-play mention in first welcome
    if (msgContext.infantCount == null) {
      msgContext.infantCount = Number(g.infant_count || g.infants || g.infantCount || 0);
    }
    if (msgContext.childCount == null) {
      msgContext.childCount = Number(g.child_count || g.children || g.childCount || 0);
    }
    if (msgContext.adultCount == null) {
      msgContext.adultCount = Number(g.adult_count || g.adults || g.adultCount || 0);
    }
  }
  if (msgContext.petCount == null && msgContext.number_of_pets != null) {
    msgContext.petCount = Number(msgContext.number_of_pets) || 0;
    if (msgContext.hasPets == null) msgContext.hasPets = msgContext.petCount > 0;
  }
  if (msgContext.petCount == null && msgContext.pets != null) {
    const p = Number(msgContext.pets);
    if (!isNaN(p)) {
      msgContext.petCount = p;
      if (msgContext.hasPets == null) msgContext.hasPets = p > 0;
    }
  }
  // Direct top-level infant/child counts (some webhook shapes)
  if (msgContext.infantCount == null && msgContext.infant_count != null) {
    msgContext.infantCount = Number(msgContext.infant_count) || 0;
  }
  if (msgContext.childCount == null && msgContext.child_count != null) {
    msgContext.childCount = Number(msgContext.child_count) || 0;
  }

  // === Early enrichment from full reservation details (for reliable petCount, checkIn/Out, listing on NEW_RESERVATION_WELCOME etc) ===
  // Message webhooks after booking often lack the full guests.pet_count etc that reservation.created provided in the old system.
  // Fetching here ensures the agent + welcome logic has accurate hasPets/petCount for the critical pet fee mismatch rules.
  // (Inquiries are enriched separately below using getInquiryDetails.)
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
          // Capture infant/child counts (for proactive pack-and-play info in first NEW_RESERVATION_WELCOME)
          if (msgContext.infantCount == null) {
            msgContext.infantCount = Number(fullRes.guests.infant_count || fullRes.guests.infants || fullRes.guests.infantCount || 0);
          }
          if (msgContext.childCount == null) {
            msgContext.childCount = Number(fullRes.guests.child_count || fullRes.guests.children || fullRes.guests.childCount || 0);
          }
        }
        if (fullRes.properties?.[0]) {
          if (!msgContext.listingId) msgContext.listingId = fullRes.properties[0].id;
          if (!msgContext.propertyName) msgContext.propertyName = fullRes.properties[0].name;
        }
        if (fullRes.arrival_date && !msgContext.checkIn) msgContext.checkIn = fullRes.arrival_date; // some shapes
        if (fullRes.departure_date && !msgContext.checkOut) msgContext.checkOut = fullRes.departure_date;
        // Reservation status (Julia already-cancelled incident): prefer reservation_status.current.category
        const statusCategory =
          fullRes.reservation_status?.current?.category ||
          fullRes.reservation_status?.current?.status ||
          fullRes.status ||
          null;
        if (statusCategory) {
          msgContext.reservationStatus = statusCategory;
          msgContext.reservation_status = fullRes.reservation_status || { current: { category: statusCategory } };
        }
        if (fullRes.booking_date && !msgContext.bookingTimestamp && !msgContext.bookingDate) {
          msgContext.bookingTimestamp = fullRes.booking_date;
          msgContext.bookingDate = fullRes.booking_date;
        }
        console.log(
          '[Handler] Enriched msgContext from reservation details (pet/dates/listing/status for welcome & cancel logic)',
          statusCategory ? `status=${statusCategory}` : 'status=unknown'
        );
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

  // Explicitly detect inquiries.
  // Inquiries (pre-booking leads, some message.created events) legitimately arrive without a reservation_id,
  // only with conversation_id. We must NOT fall back to the message's numeric platform id.
  const hasReservation = !!(msgContext.reservationId || msgContext.reservation_id || msgContext.reservation?.id);
  const hasConversation = !!(msgContext.conversation_id || msgContext.airbnb_conversation_id);
  msgContext.isInquiry = !hasReservation && hasConversation;

  if (msgContext.isInquiry) {
    console.log('[Handler] Detected as INQUIRY (no reservation_id present) — will route to conversation-based send + context tools.');
  }

  // === Early enrichment from inquiry details (petCount / dates for NEW_INQUIRY_WELCOME pet logic) ===
  // Inquiries (invite sent, pre-booking) legitimately have no reservation yet. The guest selects #pets
  // (e.g. "2 pets") at inquiry time and this is visible in Hospitable as "2 guests, 2 pets" on the invite.
  // Without fetching /inquiries/{id} (or using the normalized webhook fields above), hasPets/petCount stay
  // falsy, the welcome prompt sees count:0, and the agent emits the "add the pets ... fee is included"
  // mismatch sentence (wrong when pets were already declared on the inquiry). Same mismatch rules apply
  // to NEW_INQUIRY_WELCOME per welcome-messages.md + pet-policy.md.
  const inquiryIdForEnrich = msgContext.conversation_id || msgContext.airbnb_conversation_id || msgContext.inquiry_id || msgContext.inquiryId;
  const needsInquiryEnrich = msgContext.isInquiry || (!reservationIdForEnrich && inquiryIdForEnrich);
  if (needsInquiryEnrich && inquiryIdForEnrich) {
    try {
      const enrichClient = new HospitableClient();
      const fullInquiry = await enrichClient.getInquiryDetails(inquiryIdForEnrich).catch((e) => {
        console.warn('[Handler] Inquiry enrichment fetch failed (non-fatal):', e?.message || e);
        return null;
      });
      if (fullInquiry) {
        // Dates (inquiries may use check_in/arrival_date or similar)
        if (!msgContext.checkIn && (fullInquiry.check_in || fullInquiry.arrival_date)) {
          msgContext.checkIn = fullInquiry.check_in || fullInquiry.arrival_date;
        }
        if (!msgContext.checkOut && (fullInquiry.check_out || fullInquiry.departure_date)) {
          msgContext.checkOut = fullInquiry.check_out || fullInquiry.departure_date;
        }

        // Pet count - try multiple shapes Hospitable uses for inquiries
        let pc = 0;
        if (fullInquiry.guests) {
          pc = Number(fullInquiry.guests.pet_count || fullInquiry.guests.pets || fullInquiry.guests.number_of_pets || fullInquiry.guests.petCount || 0);
        }
        if (!pc) {
          pc = Number(fullInquiry.pet_count || fullInquiry.pets || fullInquiry.number_of_pets || fullInquiry.petCount || 0);
        }
        if (pc > 0) {
          if (msgContext.hasPets == null) msgContext.hasPets = true;
          if (msgContext.petCount == null || msgContext.petCount === 0) msgContext.petCount = pc;
        } else if (fullInquiry.guests || fullInquiry.pet_count != null || fullInquiry.pets != null) {
          // We got a guests block or explicit pet field → trust a zero
          if (msgContext.hasPets == null) msgContext.hasPets = false;
          if (msgContext.petCount == null) msgContext.petCount = 0;
        }

        // Infant / child counts from inquiry guests (for proactive pack-and-play mention in first welcome)
        if (fullInquiry.guests) {
          const g = fullInquiry.guests;
          if (msgContext.infantCount == null) {
            msgContext.infantCount = Number(g.infant_count || g.infants || g.infantCount || 0);
          }
          if (msgContext.childCount == null) {
            msgContext.childCount = Number(g.child_count || g.children || g.childCount || 0);
          }
        }
        if (msgContext.infantCount == null) {
          msgContext.infantCount = Number(fullInquiry.infant_count || fullInquiry.infants || fullInquiry.infantCount || 0);
        }
        if (msgContext.childCount == null) {
          msgContext.childCount = Number(fullInquiry.child_count || fullInquiry.children || fullInquiry.childCount || 0);
        }

        // Property/listing if present on the inquiry record
        if (fullInquiry.properties?.[0]) {
          if (!msgContext.listingId) msgContext.listingId = fullInquiry.properties[0].id;
          if (!msgContext.propertyName) msgContext.propertyName = fullInquiry.properties[0].name;
        }

        console.log('[Handler] Enriched msgContext from inquiry details (pet/dates/listing for NEW_INQUIRY_WELCOME & pet mismatch logic)');
      }
    } catch (e) {
      console.warn('[Handler] Early inquiry enrichment skipped (non-fatal):', e?.message || e);
    }
  }

  // === Fallback: infer pet count from the guest message text for inquiries ===
  // Per docs, /inquiries should include guests.pet_count, but in practice (e.g. some Airbnb inquiries)
  // the structured count may be absent even after fetch (while the UI shows "2 guests, 2 pets").
  // If the guest explicitly declares pets in their first message ("bring our two dogs", "we have a dog", etc.)
  // and we still have no count from webhook or API, infer it so the welcome logic uses the correct
  // "pet fee already included" branch instead of the mismatch "add the pets..." text.
  if ((msgContext.petCount == null || msgContext.petCount === 0) && msgContext.isInquiry && guestMessage) {
    const inferred = inferPetCountFromMessage(guestMessage);
    if (inferred > 0) {
      msgContext.petCount = inferred;
      if (msgContext.hasPets == null) msgContext.hasPets = true;
      console.log('[Handler] Inferred petCount from inquiry guest message text (API/webhook had none):', inferred);
    }
  }

  // === Robust property / listing name normalization for ALL cases (reservations + inquiries + plain messages) ===
  // Webhook payloads often include "property" or "properties" or "listing" even for pre-booking inquiries.
  // This ensures "Property: ..." appears in prompts, traces, and (critically) SNS escalations instead of "Unknown property".
  if (!msgContext.propertyName) {
    msgContext.propertyName =
      msgContext.property?.name ||
      msgContext.property?.public_name ||
      (Array.isArray(msgContext.properties) && msgContext.properties[0]?.name) ||
      msgContext.listing?.name ||
      msgContext.listing?.public_name ||
      null;
  }
  if (!msgContext.listingId) {
    msgContext.listingId =
      msgContext.listingId ||
      msgContext.property?.id ||
      (Array.isArray(msgContext.properties) && msgContext.properties[0]?.id) ||
      msgContext.listing?.platform_id ||
      null;
  }

  console.log('\n📋 RESERVATION / INQUIRY DETAILS:');
  console.log(JSON.stringify({
    guestName: msgContext.guestName || msgContext.guest?.first_name,
    listingId: msgContext.listingId || msgContext.properties?.[0]?.id,
    propertyName: msgContext.propertyName || msgContext.properties?.[0]?.name,
    checkIn: msgContext.checkIn || msgContext.check_in,
    checkOut: msgContext.checkOut || msgContext.check_out,
    bookingDate: msgContext.bookingDate,
    reservationStatus: msgContext.reservationStatus || null,
    hasPets: msgContext.hasPets,
    petCount: msgContext.petCount,
    infantCount: msgContext.infantCount,
    childCount: msgContext.childCount,
    conversation_id: msgContext.conversation_id,
    airbnb_conversation_id: msgContext.airbnb_conversation_id,
    reservationId: msgContext.reservationId || msgContext.reservation_id,
    isInquiry: msgContext.isInquiry,
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

  // Host phones / WiFi / lockbox codes — SSM /host/contacts-json only (never in source).
  await loadHostContacts();

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
      hasStayExtensionInfo: !!result.stayExtensionInfo,
      stayExtensionCalendarChecked: result.stayExtensionInfo ? result.stayExtensionInfo.calendarChecked : null,
      stayExtensionAllAvailable: result.stayExtensionInfo ? result.stayExtensionInfo.allAvailable : null,
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
    if (result.stayExtensionInfo) {
      const se = result.stayExtensionInfo;
      console.log('📅 STAY EXTENSION / DATE AVAILABILITY:', JSON.stringify({
        detected: se.detected,
        type: se.extensionType,
        current: se.currentCheckIn + '→' + se.currentCheckOut,
        proposed: se.proposedCheckOut || se.proposedCheckIn,
        extraNights: se.extraNights,
        calendarChecked: se.calendarChecked,
        allAvailable: se.allAvailable,
        unavailable: se.unavailableDates,
        unit: se.propertyName
      }, null, 2));
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
    // Inquiries legitimately have no reservation_id (only conversation_id).
    // We use the reservation endpoint only when we have a real reservationId.
    // Otherwise we fall back to the conversation endpoint (this is the correct path for inquiries).
    if (result.shouldReply && result.proposedResponse && result.proposedResponse !== 'none' && !result.escalated) {
      const reservationId = msgContext.reservationId || msgContext.reservation_id || msgContext.reservation?.id;
      const convId = msgContext.conversation_id || msgContext.airbnb_conversation_id;

      const targetId = reservationId || convId;
      const targetType = (reservationId && !msgContext.isInquiry) ? 'reservation' : 'conversation';

      if (targetId) {
        const sentPreview = result.proposedResponse.substring(0, 80);

        // === Pre-send guard: prevent sending duplicate short replies for non-thank-you categories ===
        // THANK_YOU_MESSAGE ("You are welcome") may repeat — guests often thank us more than once.
        try {
          const skipDuplicateGuard = result.typeOfMessageReceived === 'THANK_YOU_MESSAGE';
          let recentForGuard = null;
          if (reservationId && !msgContext.isInquiry) {
            recentForGuard = await hospitableClient.getThreadMessages({ reservationId }, 4);
          } else {
            const verifyConvForGuard = convId || (reservationId ? await hospitableClient.getConversationIdForReservation(reservationId).catch(() => null) : null);
            if (verifyConvForGuard) {
              recentForGuard = await hospitableClient.getThreadMessages({ conversationId: verifyConvForGuard }, 4);
            }
          }

          if (recentForGuard && !skipDuplicateGuard) {
            const veryRecentHostReplies = recentForGuard
              .filter(m => (m.sender_type === 'host' || m.sender?.type === 'host'))
              .slice(0, 3)
              .map(m => (m.body || '').trim().toLowerCase());

            const proposedLower = result.proposedResponse.trim().toLowerCase();
            const isBareWelcomeAck = (text) =>
              text.length < 60 &&
              /you're welcome|you are welcome/i.test(text) &&
              !/heads up|sofa bed|note that|lovely stay|for the team/i.test(text);
            const isDuplicateShortReply = veryRecentHostReplies.some(r =>
              r === proposedLower ||
              (isBareWelcomeAck(proposedLower) && isBareWelcomeAck(r)) ||
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
          // For brand new inquiries (no reservation_id), the old system used a dedicated
          // sendInquiryMessage path. We now have sendMessageToInquiry (tries /inquiries/{id}/messages).
          // Many "message.created" inquiry webhooks provide a conversation_id that 404s on both
          // /conversations and /inquiries messaging endpoints for the current token/integration.
          // We special-case inquiry send failures below so they do not hard-fail the Lambda
          // (prevents the guest-messaging-agent-harness-errors alarm and SQS retry/DLQ spam).
          if (reservationId && !msgContext.isInquiry) {
            await hospitableClient.sendMessageToReservation(reservationId, result.proposedResponse);
          } else if (msgContext.isInquiry) {
            const inquiryIdForSend = msgContext.conversation_id || msgContext.airbnb_conversation_id || convId;
            console.log(`📤 SENDING REPLY → inquiry:`, inquiryIdForSend, '| preview:', sentPreview);
            await hospitableClient.sendMessageToInquiry(inquiryIdForSend, result.proposedResponse);
          } else {
            await hospitableClient.sendMessage(convId, result.proposedResponse);
          }
          console.log('✅ Reply successfully sent to guest via Hospitable');

          // === Verification (best-effort only — never a hard failure) ===
          // A 404 or missing message here is usually just eventual consistency.
          // The actual send already succeeded, so we treat verification problems as warnings.
          try {
            await new Promise(resolve => setTimeout(resolve, 3000)); // slightly longer sleep for consistency

            let recentMessages = null;
            if (reservationId && !msgContext.isInquiry) {
              recentMessages = await hospitableClient.getThreadMessages({ reservationId }, 5);
            } else {
              // Resolve conversation_id if we only have reservationId (inquiries / legacy paths)
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
                recentMessages = await hospitableClient.getThreadMessages({ conversationId: verifyConvId }, 5);
              }
            }

            if (recentMessages) {
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

          if (msgContext.isInquiry) {
            const inquiryIdForSend = msgContext.conversation_id || msgContext.airbnb_conversation_id || convId;
            console.error('🚨 INQUIRY SEND FAILED — the ID provided in the message.created webhook (reservation_id null) is not writable via the Hospitable /inquiries or /conversations messaging endpoints (404).');
            console.log('\n========== GENERATED REPLY FOR MANUAL SEND ==========');
            console.log(result.proposedResponse);
            console.log('====================================================\n');

            // Escalate the good reply for manual send: Android FCM primary, SNS email fallback.
            try {
              const guestLabel = msgContext.guestName || 'Guest';
              const propLabel =
                msgContext.propertyName ||
                msgContext.listing?.name ||
                msgContext.property?.name ||
                'N/A';
              const fcmBody = [
                'Inquiry reply ready — send manually (Hospitable send 404).',
                propLabel,
                `Guest: ${guestLabel}`,
                clip(result.proposedResponse || '', 400),
              ].join('\n');
              const fcmResult = await notifyOwnerAndroid({
                type: 'manual_reply_needed',
                title: `Inquiry reply ready — ${guestLabel}`,
                body: fcmBody,
                data: {
                  type: 'manual_reply_needed',
                  guestName: String(guestLabel),
                  property: String(propLabel),
                  category: 'NEW_INQUIRY_WELCOME',
                  conversationId: String(inquiryIdForSend || ''),
                  listingName: String(propLabel),
                  requestId: String(requestId || ''),
                },
              });
              if (fcmResult.ok) {
                console.log(
                  `📱 Inquiry manual-send alert via Android FCM (success=${fcmResult.successCount})`
                );
              } else {
                const topicArn = process.env.SNS_TOPIC_ARN;
                if (topicArn) {
                  await sns.send(
                    new PublishCommand({
                      TopicArn: topicArn,
                      Subject: `[Airbnb Inquiry] Auto-reply ready for manual send — ${guestLabel}`,
                      Message: [
                        'Brand new inquiry (no reservation_id in webhook).',
                        '',
                        `Guest: ${guestLabel}`,
                        `Listing / Property: ${propLabel}`,
                        `Webhook conversation_id: ${inquiryIdForSend}`,
                        `Original message: ${guestMessage || msgContext.body || '(see CloudWatch)'}`,
                        '',
                        'GENERATED REPLY (send this manually via Hospitable or the Chrome extension):',
                        result.proposedResponse,
                        '',
                        'FCM was unavailable; this is the SNS email fallback.',
                        `Request ID: ${requestId}`,
                      ].join('\n'),
                    })
                  );
                  console.log('📧 Inquiry manual-send alert published to SNS_TOPIC_ARN (FCM fallback)');
                } else {
                  console.warn(
                    'Inquiry escalation: FCM unavailable and SNS_TOPIC_ARN unset; reply text is in logs above'
                  );
                }
              }
            } catch (notifyErr) {
              console.warn(
                'Could not publish inquiry escalation (reply text is printed in the logs above):',
                notifyErr.message
              );
            }

            // Return a clean 200 success. This acks the SQS message, avoids incrementing the Lambda Errors metric,
            // stops the guest-messaging-agent-harness-errors alarm for inquiry traffic, and prevents further retries/DLQ.
            const duration = Date.now() - startTime;
            console.log('\n⏱️  Total handler duration:', duration, 'ms (inquiry reply generated + escalated; no hard send error)');
            console.log('═══════════════════════════════════════════════════════════════\n');

            return {
              statusCode: 200,
              body: JSON.stringify({
                success: true,
                requestId,
                decision: {
                  typeOfMessageReceived: result.typeOfMessageReceived,
                  proposedResponse: result.proposedResponse,
                  shouldReply: true,
                  escalated: false,
                  inquirySendFailed: true,
                  manualDeliveryRequired: true
                },
                note: 'Inquiry reply generated and approved by judge/reflection but could not be auto-delivered (404 on send for the webhook conversation/inquiry ID). Full text published to SNS and logged for manual send.'
              })
            };
          }

          // Reservation-path (or other non-inquiry) send failures remain hard errors.
          // This preserves the designed behavior: DLQ after max receives + alarm visibility.
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

    // Critical Hospitable failures (after retries) and missing conversation history
    // must cause a hard Lambda failure so SQS can retry or send to DLQ, and alarms can trigger.
    const isHardFailure =
      error.name === 'CriticalHospitableError' ||
      error.name === 'ConversationHistoryRequiredError' ||
      error.message.includes('CRITICAL HOSPITABLE') ||
      error.message.includes('CRITICAL: Live conversation history');

    if (isHardFailure) {
      console.error('\n🚨🚨 CRITICAL FAILURE — HARD LAMBDA FAILURE (no silent proceed without history)');
      console.error('Error type:', error.name);
      console.error('Operation:', error.operation);
      console.error('Attempts:', error.attempts);
      console.error('History source:', error.historySource);
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
