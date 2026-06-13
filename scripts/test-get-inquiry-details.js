#!/usr/bin/env node
/**
 * Live test for Hospitable inquiry details fetch (getInquiryDetails).
 *
 * Purpose: Verify that we can correctly retrieve pet info (and other context) for inquiries
 * using the exact same HospitableClient.getInquiryDetails() that the Lambda handler
 * and ConversationContextTool use for NEW_INQUIRY_WELCOME + pet mismatch logic.
 *
 * === Nicole case (the bug we just fixed) ===
 * - Event: "Invite sent Nicole"
 * - Property: 53 Pine St #3 · Cozy, Central 2 Bd Apt, Parking with EV charger
 * - Dates: Jun 13–14 (1 night)
 * - Visible in UI: "2 guests, 2 pets · $459.68"
 * - Bad auto-reply sent: "Yes, we are pet-friendly ... please add the pets to your reservation so the fee is included"
 *   (because petCount was not populated on the inquiry path)
 *
 * This script exercises the real enrichment path end-to-end:
 *   - client.getInquiryDetails(id)
 *   - Exact pet extraction logic copied from lambda/handler.js (inquiry enrich block)
 *     and src/tools/conversation/ConversationContextTool.js
 *   - Also tries getConversationMessages (inquiry webhooks often supply a conversation_id usable here)
 *
 * Usage:
 *   HOSPITABLE_BEARER_TOKEN=xxx node scripts/test-get-inquiry-details.js <id>
 *   # or (falls back to SSM /hospitable/bearer-token like Lambda)
 *   node scripts/test-get-inquiry-details.js <id>
 *
 * For the Nicole case, pass the conversation_id or inquiry_id from that webhook / thread.
 * (Look in CloudWatch around the incident time, or the Hospitable conversation URL.)
 */

import { HospitableClient } from '../src/clients/HospitableClient.js';

const client = new HospitableClient();

function extractPetFromInquiry(inquiry) {
  // This is the exact tolerant extraction used in production for inquiry enrichment
  // (ConversationContextTool + the dedicated handler block after isInquiry detection).
  let pc = 0;
  if (inquiry?.guests) {
    pc = Number(
      inquiry.guests.pet_count ||
      inquiry.guests.pets ||
      inquiry.guests.number_of_pets ||
      inquiry.guests.petCount ||
      0
    );
  }
  if (!pc) {
    pc = Number(
      inquiry?.pet_count ||
      inquiry?.pets ||
      inquiry?.number_of_pets ||
      inquiry?.petCount ||
      0
    );
  }

  let hasPets = null;
  let petCount = null;

  if (pc > 0) {
    hasPets = true;
    petCount = pc;
  } else if (inquiry?.guests || inquiry?.pet_count != null || inquiry?.pets != null) {
    // We saw a guests block or explicit pet field → trust zero
    hasPets = false;
    petCount = 0;
  }

  return { hasPets, petCount, rawPc: pc };
}

async function main() {
  const id = process.argv[2];

  if (!id) {
    console.error('Usage: node scripts/test-get-inquiry-details.js <inquiryId-or-conversationId>');
    console.error('');
    console.error('Nicole case example (replace with the real ID from that invite-sent event):');
    console.error('  HOSPITABLE_BEARER_TOKEN=... node scripts/test-get-inquiry-details.js a1b2c3d4-e5f6-...');
    console.error('');
    console.error('The ID is usually the conversation_id (or airbnb_conversation_id) that came in the webhook,');
    console.error('or the internal inquiry id. Check the raw SQS / CloudWatch payload for the Nicole thread.');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 LIVE HOSPITABLE INQUIRY FETCH TEST');
  console.log('   Endpoint: GET /inquiries/{id} via HospitableClient.getInquiryDetails');
  console.log('   ID:', id);
  console.log('   (Nicole pet-declared inquiry regression test)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    console.log('→ Calling getInquiryDetails...');
    const inquiry = await client.getInquiryDetails(id);

    if (!inquiry) {
      console.log('❌ getInquiryDetails returned null/empty.');
      process.exit(1);
    }

    console.log('✅ SUCCESS: Fetched inquiry details.\n');

    // Full raw dump (most useful for seeing the real Hospitable shape)
    console.log('RAW RESPONSE (full object):');
    console.dir(inquiry, { depth: 5, colors: true });

    console.log('\n───────────────────────────────────────────────────────────────');
    console.log('KEY FIELDS FOR PET / NEW_INQUIRY_WELCOME LOGIC');
    console.log('───────────────────────────────────────────────────────────────');
    console.log('status:           ', inquiry.status);
    console.log('check_in / arrival:', inquiry.check_in || inquiry.arrival_date || inquiry.checkIn);
    console.log('check_out / dep:  ', inquiry.check_out || inquiry.departure_date || inquiry.checkOut);
    console.log('guests block:     ', JSON.stringify(inquiry.guests, null, 2));
    console.log('top-level pets?:  ', {
      pet_count: inquiry.pet_count,
      pets: inquiry.pets,
      number_of_pets: inquiry.number_of_pets,
      petCount: inquiry.petCount
    });
    console.log('properties[0]:    ', inquiry.properties?.[0] ? {
      id: inquiry.properties[0].id,
      name: inquiry.properties[0].name
    } : null);

    const pet = extractPetFromInquiry(inquiry);

    console.log('\n───────────────────────────────────────────────────────────────');
    console.log('PET EXTRACTION (exact production logic from handler + ContextTool)');
    console.log('───────────────────────────────────────────────────────────────');
    console.log('hasPets :', pet.hasPets);
    console.log('petCount:', pet.petCount);

    if (pet.petCount > 0) {
      console.log('\n✅ CORRECT: petCount > 0 detected from live /inquiries response.');
      console.log('   The agent will now see the right value and should use the');
      console.log('   "pet fee is already included" branch (or omit if not mentioned).');
    } else if (pet.hasPets === false) {
      console.log('\nℹ️  Zero pets explicitly confirmed by the inquiry record.');
    } else {
      console.log('\n⚠️  No usable pet fields in the inquiry record.');
      console.log('   Webhook normalization (guests.pet_count etc. at message time) would be the only source.');
    }

    // Bonus: try conversation messages on the same ID (very common for inquiry webhooks)
    console.log('\n→ Also attempting getConversationMessages on the same ID...');
    try {
      const msgs = await client.getConversationMessages(id, 6);
      console.log(`   Fetched ${msgs.length} recent messages.`);
      if (msgs.length > 0) {
        const last = msgs[0];
        console.log('   Most recent:', {
          sender: last.sender_type || last.sender?.type,
          preview: (last.body || '').substring(0, 140)
        });
      }
    } catch (mErr) {
      console.log('   getConversationMessages on this ID failed (common/expected for some inquiry refs):', mErr.message);
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('Test finished. Look at the "guests" block + extracted petCount above.');
    console.log('For the Nicole case we expect petCount === 2 and hasPets === true.');
  } catch (err) {
    console.error('\n❌ FETCH FAILED');
    console.error('Error name   :', err.name);
    console.error('Message      :', err.message);
    if (err.response) {
      console.error('HTTP status  :', err.response.status);
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
    if (err.attempts) {
      console.error('Attempts     :', err.attempts);
    }
    console.error('\nIf this is a 404 or 403, the ID may be a conversation reference that is not');
    console.error('directly addressable via /inquiries, or the token lacks inquiry read scope.');
    console.error('The handler catches these non-fatally and relies on webhook normalization.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Unexpected crash:', e);
  process.exit(1);
});
