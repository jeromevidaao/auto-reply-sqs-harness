#!/usr/bin/env node
/**
 * Quick helper: fetch a real conversation_id from Hospitable for a given listing.
 *
 * Usage:
 *   node scripts/get-real-conversation-id.js <listing-uuid> [limit]
 *
 * Example:
 *   node scripts/get-real-conversation-id.js 114663c5-0709-4eff-a868-fa9ebd6ed42d
 *
 * Requires either HOSPITABLE_BEARER_TOKEN in env or valid AWS creds for SSM.
 */

import { HospitableClient } from '../src/clients/HospitableClient.js';

async function main() {
  const listingId = process.argv[2];
  const limit = parseInt(process.argv[3] || '5', 10);

  if (!listingId) {
    console.error('Usage: node scripts/get-real-conversation-id.js <listing-uuid> [limit]');
    console.error('Example: node scripts/get-real-conversation-id.js 114663c5-0709-4eff-a868-fa9ebd6ed42d');
    process.exit(1);
  }

  const client = new HospitableClient();

  try {
    const reservations = await client.getReservations({
      properties: listingId,
      limit,
      sort: '-arrival_date'
    });

    if (reservations.length === 0) {
      console.log('No reservations found for that listing.');
      return;
    }

    console.log(`Found ${reservations.length} reservation(s) for ${listingId}:\n`);

    reservations.forEach((r, i) => {
      console.log(`${i + 1}. reservation.id: ${r.id}`);
      console.log(`   conversation_id: ${r.conversation_id || '(none)'}`);
      console.log(`   status: ${r.status}`);
      console.log(`   ${r.arrival_date} → ${r.departure_date}`);
      if (r.guest?.first_name) console.log(`   guest: ${r.guest.first_name}`);
      if (r.conversation_id) {
        console.log(`   Airbnb messages URL: https://www.airbnb.com/hosting/messages/${r.conversation_id}`);
      }
      console.log('');
    });

    const firstWithConv = reservations.find(r => r.conversation_id);
    if (firstWithConv) {
      console.log('✅ Recommended for test escalation payloads:');
      console.log(JSON.stringify({
        conversation_id: firstWithConv.conversation_id,
        listingId: listingId,
        guestName: firstWithConv.guest?.first_name || 'Guest'
      }, null, 2));
    }
  } catch (err) {
    console.error('Failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

main();