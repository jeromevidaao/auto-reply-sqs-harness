# Golden: NEW_RESERVATION_WELCOME for Emma (Downtown Studio spring break sharing — real escalation incident)

**Scenario**: Real production escalation: Guest Emma's first post-booking message for the Downtown Studio (1B, "Walk Everywhere, Parking"). Pure positive intro sharing her past connection to Maine College of Art + excitement for college roommates' spring break trip "next year" (2027-03-23/25 dates, far future). No question or specific ask. Previously the agent output NEW_RESERVATION_WELCOME + conf 0.95 but decided not to auto-reply (escalated "Manual reply needed"). Must now treat as NEW_RESERVATION_WELCOME, produce rich informative first-page welcome, with shouldReply:true and (forced) confidence 1.0.

**Context highlights**:
- Far-future stay (2027, days >> 3)
- No pets, no infants
- Guest name: Emma (simple)
- Empty history (true first host/auto message in thread)
- Property: "Downtown Studio, Walk Everywhere, Parking" (1B listing)
- Exact guest text (with the "Iare" typo preserved for realism)

**Requirements (from rubric + user report)**:
- expectedCategory: "NEW_RESERVATION_WELCOME"
- shouldReply: true (must not escalate)
- Must start with Eastern time greeting + "Emma," (e.g. "Good afternoon, Emma,")
- Warmly acknowledge the spring break / college / Portland connection / excitement (natural, not robotic)
- Must include core rich welcome logistics for future >=3d pure NEW_RES:
  - "self-check-in"
  - "4pm" (check-in time phrasing)
  - dedicated off-street "parking" (or "one dedicated off-street parking spot")
  - exact substring "detailed check-in instructions 3 days before" (the 3-day sentence)
- No minimal/curt reply ("let me know if you have any questions", just "happy to hear")
- No "feel free to book" (already booked)
- No pet mention (correct, petCount=0 + no mention)
- Sign naturally (Jerome or Jerome & Ruby)
- Overall: the forcing logic (agent.js) + prompt rules (welcome + base) + judge/reflection notes must ensure this auto-replies at confidence 1.0

**Example of good output** (tone/facts > verbatim match; must hit all required phrases + greeting + name):
"Good afternoon, Emma, thanks for the note — how nice that you studied at Maine College of Art and the location brings back good memories! We have one dedicated off-street parking spot. Check-in is at 4pm with self-check-in. I will send the detailed check-in instructions 3 days before your arrival.

Looking forward to hosting you and your roommates for spring break.

Jerome & Ruby"

**Notes on the incident & fix**: This was the trigger for revisiting confidence handling. No hard numeric "escalate if < X" threshold existed in code — the gate was the LLM's shouldReply (or later judge REJECT) + lack of forcing for welcome cats (unlike early-flex). The Emma case (and similar pure sharing) must now reliably auto-reply with the full practical welcome the user expects. Added eval scenario+golden + prompt + code force to 1.0 locks it. The "revisit threshold" is addressed by biasing strongly to 1.0 + reply for these safe categories (LLM instructed to emit 1.0; post-process enforces).

**Related**: first-post-booking-birthday-abby (the prior similar case that was fixed for 4pm/3-day richness).
