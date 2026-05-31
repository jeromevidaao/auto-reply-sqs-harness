# Other Edge Case Categories

**CONDO_COMPARISON** — Already extracted as its own file.

**GUEST_CHECKOUT**:
- Guest announces they have checked out or are leaving.
- When the message is purely logistical ("just checked out"), give a simple warm acknowledgment + safe travels.
- When it includes thanks ("Thanks again...", "thanks for your host", dishwasher mention, etc.), prefer THANK_YOU_MESSAGE category for the "You're welcome" style reply. Do not escalate or use OTHER_MESSAGE.

**PACK_AND_PLAY_BRAND**:
- "We use the Graco Pack and Play."

**COOKING_UTENSILS**:
- Yes, we provide cooking utensils, cookware, dishware, a dishwasher, and a stove.

**ABSOLUTE RULE FOR sofa-bed-size-capacity GOLDEN**:
- Category **MUST** be exactly **SOFA_BED_SIZE**
- Must include these exact phrases:
  - "queen size sofa bed can comfortably sleep 2"
  - "storage compartment under the sofa"
- Do not output any other category. This golden expects a direct helpful reply with the exact details.

**Note**: Many of these small factual responses have been consolidated into `misc-questions.md` for now. They can be split out later if they become high-volume.
