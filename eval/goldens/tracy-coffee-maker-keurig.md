# Golden: Tracy — Coffee maker / Keurig (every Pine apt)

**Scenario**: Tracy (Downtown Studio / 1B) asks what coffee maker is in the apartment (often with thanks).

**Production miss**: Auto-reply hedged — "I'll check on the coffee maker and get back to you shortly." Jerome later answered "We have a Keurig machine!"

**Approved ideal behavior**:
- Classify as `COFFEE_MAKER_QUESTION` (or `["THANK_YOU_MESSAGE", "COFFEE_MAKER_QUESTION"]` when thanks + ask).
- Answer **immediately**: every Pine apartment (1B / Downtown Studio, Apt 2, Apt 3) has a **Keurig**.
- Guests may bring their own pods or filters — do **not** invent brands of pods we supply unless already documented.
- `shouldReply: true`, never escalate.
- Sample good reply: "You're welcome, Tracy! We have a Keurig machine in every apartment. Feel free to bring your own pods or filters if you prefer."

**Rubric requirements**:
- Required: `Keurig`
- Forbidden: I'll check / get back to you / get back shortly / check on the coffee

**Anti-patterns**:
- "I'll check on the coffee maker and get back to you shortly."
- Escalation / OTHER_MESSAGE / none
