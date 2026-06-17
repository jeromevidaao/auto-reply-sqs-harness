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

**Sofa bed linens (sheets / blankets / pillows)**:
- When confirming linens for a sofa bed or couch sleeper (pre-arrival or general): always say we provide them **and** that they are stored in the **storage compartment under the sofa** (in the sofa itself). See `extra-linens-towels.md` for full rules and in-stay lift-up instructions.
- For Apt 2 / Apt 3 sleeping-arrangement replies: mention the sofa bed in the living room sleeps 2 and linens are stored under it — e.g. "we provide the linens for the sofa bed (stored under it)".

**Anti-repetition note**:
- If accommodation capacity was already explained earlier in the conversation, do not repeat the full bed details unless asked again.
