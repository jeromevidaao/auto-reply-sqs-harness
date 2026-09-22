# Golden: Kenneth Extra Towels → Sofa Ikea Lift-up (Apt 2 in-stay)

**Scenario**: Kenneth (West End Victorian / Pine Apt 2, Sep 22–25 2026, party of 5) is already in the unit and asks for more bath towels — they only have 4 towel sets for 5 people. Real production miss where the auto-reply invented a linen closet / bathroom sink location and offered to bring towels over.

**Approved ideal behavior**:
- Recognize as **EXTRA_LINENS_TOWELS** (in-stay find extras).
- Tell them extras are under the **living-room sofa** (Ikea storage sofa/bed).
- Instruct clearly: **lift the long seat cushion or top section up** to open the storage underneath — towels and linens are inside.
- Offer help only if they cannot find them ("If you cannot find them, feel free to let us know.").
- **Never** say linen closet, bathroom sink, cabinets, or drawers.
- **Never** first-reply with "I'll bring towels right over" when sofa storage exists.

**Rubric requirements**:
- Must reply.
- Must mention sofa, lift, and under.
- Must not mention linen closet, bathroom sink, cabinets, or bring-right-over delivery.

**Example of good output**:
"Kenneth, extra bath towels and linens are stored under the living-room sofa (it's an Ikea storage sofa/bed). Lift the long seat cushion or top section up to open the storage underneath — the towels and linens are inside. If you cannot find them, feel free to let us know."

**Why this golden exists**:
- Locks Apt 2/3 sofa storage facts after the Kenneth closet/sink hallucination.
- Same facts apply to Apt 3; Studio/1B stays on its own rules.
