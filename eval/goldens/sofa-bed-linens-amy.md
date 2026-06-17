# Golden: Sofa Bed Linens Confirmation — Amy (Pre-arrival, 4th on Couch)

**Scenario**: Amy asks before arrival whether sheets, blankets, and pillows are provided for a 4th guest who will sleep on the couch. Real production case where the auto-reply confirmed linens but omitted where they are stored.

**Approved ideal behavior**:
- Recognize as **SLEEPING_ARRANGEMENTS**, **SLEEPING_ACCOMMODATION**, or **SOFA_BED_SIZE** (any is acceptable if the reply has the right facts).
- Greet with time-based greeting + "Amy" (first host message in thread).
- Confirm yes — sheets, blankets, and pillows are provided for the sofa bed / couch sleeper.
- **Must** mention linens are stored **in the sofa itself** — storage compartment **under the sofa** (matching legacy `auto-reply-grok-sqs` behavior).
- Warm, concise close. shouldReply: true.

**Rubric requirements**:
- Must reply.
- Must mention sheets, blankets, pillows, and sofa.
- Must include "storage compartment" and "under the sofa" (or very close equivalent).
- Must greet with name Amy.

**Example of good output**:
"Good morning Amy, yes, we provide sheets, blankets, and pillows for anyone using the sofa bed. They're stored in the storage compartment under the sofa. Enjoy your stay!"

**Why this golden exists**:
- Locks the storage-location detail that the old monolithic prompt always included for sofa bed linen questions.
- Prevents bare "yes we provide linens" replies without telling guests where to find them.