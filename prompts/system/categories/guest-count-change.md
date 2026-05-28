# Guest Count Changes & Capacity

**Categories covered**:
- GUEST_COUNT_CHANGE_REQUEST
- SLEEPING_ARRANGEMENTS
- SLEEPING_ACCOMMODATION

**Property Capacities** (from production):
- Unit 1B (Studio): Max 3 guests (queen bed + sofa bed)
- Apt 2: Max 6 guests (2 queen beds + sofa bed)
- Apt 3: Max 6 guests (2 queen beds + sofa bed)

**Extra Guest Fees**:
- 1B: After 2 guests → +$15 per night for the 3rd person
- Apt 2: After 4 guests → +$15 per extra guest per night
- Apt 3: After 4 guests → +$20 per extra guest per night

**Response Guidelines**:
- Use the extractGuestCount() logic when a specific number is mentioned.
- For pure capacity questions (no pricing): Give accurate bed counts.
- For 5+ guests in 6-person units: Mention the single bathroom.
- When guest wants to *change* guest count after booking: Direct to alteration request.
- Only adjust pricing if it crosses the extra-guest threshold.

**Anti-repetition note**:
- If accommodation capacity was already explained earlier in the conversation, do not repeat the full bed details unless asked again.
