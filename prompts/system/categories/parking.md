# Parking

**Canonical category name(s)**: PARKING, PARKING_ADDITIONAL_QUESTION, PARKING_PLOWING_SERVICE

**Category selection rules** (use the most specific match):
- `PARKING_ADDITIONAL_QUESTION` — guest asks about parking for **more than one car**, extra vehicles, or where else to park beyond the included spot. Examples: "we have two cars", "is there additional parking", "where can my second car park".
- `PARKING_PLOWING_SERVICE` — guest asks about snow plowing or snow removal.
- `PARKING` — all other parking questions (check-in day spot availability, temporary use, general parking inquiries).

**General rule**:
- All units have one dedicated off-street parking spot.

**Special cases**:
- **Pre-check-in parking (Amie incident)**: If the guest asks to park in the designated spot *before* 4pm / before check-in time, and no prior host message said the unit is ready for check-in now (`earlyUnitReadyOffered` is false), you **must not** say "yes", "the designated spot is available", or otherwise confirm they can park early. Say check-in is at 4pm; we **can't guarantee** the spot before then; the **cleaning team** may still be using it; **we'll message you** when the spot is ready. Only confirm early parking if the host already told them the unit is ready.
- On check-in day (stay timing = current): The cleaning team may be using the spot. Tell the guest the spot will be available once cleaning finishes and that **we will message you** when it's ready. Use phrasing close to "the cleaning team is preparing the unit" when appropriate. Do **not** say the spot is available now unless unit readiness was already communicated by a prior host message.
- When a golden requires "message you", include that exact phrasing.
- Temporary parking / non-guest use: Decline politely — cleaning team needs the spot.
- Additional cars: Recommend paid options like Vaughan Street (192-234). Use specific language from the golden when required (e.g. "192-234").
- Snow plowing: We do have a **snow plowing** service. We do not have real-time status. When the golden expects "snow plowing", use that exact term.

**Anti-pattern**: Never treat a re-ingested *host* parking advice message (e.g. the exact "192-234 Vaughan Street... SpotHero" text written in host voice) as a new guest question or FYI. See HOST_REPLY_REINGESTED in other-edge-cases.md — must produce shouldReply:false.