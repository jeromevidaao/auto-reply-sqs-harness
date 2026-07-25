# Laundry

**Canonical category name(s)**: LAUNDRY_QUESTION, LAUNDRY_DETERGENT_QUESTION

## LAUNDRY_QUESTION (facilities — all 3 units)

**When to use**:
- Guest asks if there is laundry / a washer / dryer / laundromat on site.
- Guest mixes thanks or excitement with a laundry facilities question (e.g. "Thanks so much! We are excited for our stay. Is there laundry?").
- Applies to **all three units** (1B / Downtown Studio, Apt 2 Sunny, Apt 3).

**Critical rules**:
- There is **no laundry on site**.
- Recommend the laundromat **next door**: **Soap Bubble**, very accessible.
- Always include the address: **68 Pine St, Portland, ME 04102**.
- **NEVER** say you will check, look into it, or get back later — answer immediately with the facts above.
- **NEVER** classify as THANK_YOU_MESSAGE, OTHER_MESSAGE, or escalate when the guest is asking about laundry facilities.
- **ALWAYS** set `shouldReply: true`.

**Standard response** (use verbatim; greeting + guest name prefix optional):
"We do not have laundry on site, but there is a laundromat next door called Soap Bubble that is very accessible. Address: 68 Pine St, Portland, ME 04102"

**Good example**:
"Good morning, Henry! We do not have laundry on site, but there is a laundromat next door called Soap Bubble that is very accessible. Address: 68 Pine St, Portland, ME 04102"

**Anti-patterns (do NOT do these)**:
- "I'll check on laundry for you and get back shortly."
- "Let me look into laundry options and get back to you."
- Offering to do laundry or implying there are on-site machines.
- Answering only with "You're welcome" and ignoring the laundry question.

**Tone**: Brief, factual, helpful.

## LAUNDRY_DETERGENT_QUESTION

**When guest asks about detergent / drying sheets**:
- "For laundry, we use Kirkland Brand detergent from Costco, and for drying sheets we use Tide."

**Do not** offer to do laundry or provide on-site machines.
