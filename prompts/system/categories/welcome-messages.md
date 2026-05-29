# Welcome Messages (NEW_RESERVATION_WELCOME & NEW_INQUIRY_WELCOME)

**Canonical category name(s)**: NEW_RESERVATION_WELCOME, NEW_INQUIRY_WELCOME

## NEW_RESERVATION_WELCOME
- This is the response when a guest has just booked (confirmed reservation).
- Start with appropriate time-based greeting + guest name.
- Welcome them warmly.
- Include key info: check-in time, parking, self-check-in.
- For new reservation welcomes, it is often natural and correct to mention "Ruby" (as in "Jerome & Ruby") and explicitly say "self-check-in" when describing arrival.
- **CRITICAL**: The reservation is ALREADY CONFIRMED — never say "feel free to book".
- Pet logic: 
  - If guest mentions pets in message but reservation has petCount=0 → remind them to add via alteration request ($30 fee).
  - If petCount > 0 → confirm fee is included and note pets not allowed on beds.
- For check-in day (stay timing = current):
  - If unit is ready on arrival → "The apartment is ready for you! You can check in anytime."
  - Otherwise → mention 4PM with early option if cleaning finishes early.
- For future stays (days until check-in >= 3) → "I will send detailed check-in instructions 3 days before arrival."
- Never include bit.ly links (Hospitable API rejects them).

## NEW_INQUIRY_WELCOME
- Used for inquiries (not yet booked).
- Answer their specific questions.
- Use real availability data if available (from context).
- If dates are available: invite them to book.
- If not available: give the exact unavailable phrasing from production.
- Same pet mismatch logic as above.
- End by encouraging them to book.

## General Rules for Both
- Use conversation history to avoid repetition.
- Be warm but not overly effusive if it would repeat prior tone.
- Include house manual / guidebook references only when appropriate (avoid bit.ly).
