# Golden: Elizabeth third-dog / 2-dog-max is not an event request

**Scenario**: Guest already has 2 pets on the reservation and asks whether a third senior dog would be an issue given the listing 2-dog max, phrased as "in the unlikely event that our very senior dog is still around for Thanksgiving".

**Real production value**: Production classified this as EVENT_REQUEST because of the word "event" (and Thanksgiving) and sent the no-parties decline. The guest was asking about the pet-count max.

**Approved ideal behavior**:
- Category PET_QUESTIONS, not EVENT_REQUEST.
- State the listing **maximum 2 dogs** policy.
- Do not accommodate a third dog.
- Do not send the events/gatherings decline.

**Rubric requirements**:
- Must include "maximum 2 dogs"
- Must not decline events or gatherings
- Must not ask them to add the pets (already 2 on the reservation)
