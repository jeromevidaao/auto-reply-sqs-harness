# Other Edge Case Categories

**CONDO_COMPARISON** — Already extracted as its own file.

**GUEST_CHECKOUT**:
- Guest announces they have checked out or are leaving **at end of stay** (checkout day or explicit "checked out" / dishwasher / "thanks for hosting" language).
- When the message is purely logistical ("just checked out"), give a simple warm acknowledgment + safe travels.
- When it includes thanks ("We have checked out. Thank you for a great stay!", "We are all checked out. Thanks for hosting!!", "Thanks again...", dishwasher mention, etc.), classify as THANK_YOU_MESSAGE (optionally with GUEST_CHECKOUT). Reply must be **warm and multi-sentence**: (1) You're welcome, (2) thanks for staying / glad you enjoyed, (3) safe travels **or** hope to see you again. Do **not** ship a bare "You're welcome, [Name]!" (Sarah / Julia checkout incidents). Do not escalate or use OTHER_MESSAGE. Never demote to bare You're welcome because `guestArrived` is still true after Schlage PIN from earlier in the stay.
- **NOT GUEST_CHECKOUT**: Guest says they "left the apartment" on check-in day or mid-stay to let staff deliver something (blanket, maintenance knock, item by the door). They are still staying — use THANK_YOU_MESSAGE with brief "You're welcome, [Name]!" only, no safe travels (Amie incident).

**PACK_AND_PLAY_BRAND**:
- See the full definition and rules in misc-questions.md. Future-guest availability asks: pre-placed Graco Pack and Play, never "upon request". Current guest already in the unit asking **where** it is (Michael Apt 2): give the storage location (Apt 2 = closet of the smaller bedroom) + "Let us know if you cannot find it." When first-host greeting instructions apply on an availability ask, prefix with greeting + name but keep this as the primary category.

**COOKING_UTENSILS**:
- Yes, we provide cooking utensils, cookware, dishware, a dishwasher, and a stove.

**COFFEE_MAKER_QUESTION**:
- See misc-questions.md. Every Pine apt (1B / Downtown Studio, Apt 2, Apt 3) has a Keurig. Answer immediately — never "I'll check" / "get back to you". Guests may bring pods/filters; do not invent supplied pod brands.

**ABSOLUTE RULE FOR sofa-bed-size-capacity GOLDEN**:
- Category **MUST** be exactly **SOFA_BED_SIZE**
- Must include these exact phrases:
  - "queen size sofa bed can comfortably sleep 2"
  - "storage compartment under the sofa"
- Do not output any other category. This golden expects a direct helpful reply with the exact details.

**Note**: Many of these small factual responses have been consolidated into `misc-questions.md` for now. They can be split out later if they become high-volume.

---

## HOST_REPLY_REINGESTED (Critical Regression Protection)

**This is a host's own previous reply text that was re-ingested into the queue as if it were a new guest message.**

**If the incoming guestMessage is exactly or extremely close to: "Hi - For paid parking, we have 192-234 Vaughan Street Parking nearby. The alternative is to find street parking in the area, usually towards the Western Promenade. I recommend using the SpotHero application, where you can book in advance and get cheaper rates. Hope this helps!" — this is the canonical re-ingested host parking advice. You MUST treat it as HOST_REPLY_REINGESTED, set shouldReply:false and proposedResponse:"none". Do not reply with any version of this text.**

### Recognition rules (content-based, no sender metadata required)
The incoming message is written from the *host's perspective speaking to the guest*:
- Uses "we have", "I recommend", "hope this helps", offers specific local recommendations as if answering a question.
- Contains detailed host-only advice (exact addresses, apps like SpotHero, paid parking instructions, etc.).
- Does **not** read like a guest asking the host a question ("where can we park?", "any parking recommendations?").

**Exact failing example** (must produce shouldReply:false):
"Hi - For paid parking, we have 192-234 Vaughan Street Parking nearby. The alternative is to find street parking in the area, usually towards the Western Promenade. I recommend using the SpotHero application, where you can book in advance and get cheaper rates. Hope this helps!"

This exact text (or extremely similar host-style parking advice) appears in the golden `host-parking-reply-ingested`.

### Mandatory output for this case
```json
{
  "typeOfMessageReceived": "HOST_REPLY_REINGESTED",
  "proposedResponse": "none",
  "shouldReply": false,
  "confidence": 0.95,
  "notes": "Re-ingested previous host reply about parking. Do not generate any response or escalate."
}
```

### Absolute requirements
- `shouldReply` **MUST** be false.
- `proposedResponse` **MUST** be exactly "none".
- Never include any parking advice, "192-234", "Vaughan", "SpotHero", or similar details in any output.
- Do **not** treat as FYI_STATEMENT, PARKING_ADDITIONAL_QUESTION, or any other category that would trigger a reply.
- Do **not** escalate (the whole point of this golden is to prevent the old system's false-positive escalations on host echo messages).
- This rule takes precedence over all FYI, courtesy, or informational statement rules.

### Why this exists
Some SQS/webhook ingestion paths can feed a host's prior reply back as a "new guest message". Replying to it (or escalating it) creates duplicate messages to guests and noise for the host. The eval golden `host-parking-reply-ingested-as-guest` (with rubric `shouldReply: false` + forbiddenPhrases) exists specifically to lock this behavior. The classification decision must come from the LLM via these instructions — no regex or deterministic code may decide this.
