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
- **Multi-categorization (required when mixed)**: If the guest also says thanks / excitement / "appreciate", set `typeOfMessageReceived` to an **array** including both intents, e.g. `["THANK_YOU_MESSAGE", "LAUNDRY_QUESTION"]`. Do **not** soft-classify as only `THANK_YOU_MESSAGE`.
- **Combined reply**: When multi-intent, put a short "You're welcome, [Name]!" (or "You're welcome!") **and** the Soap Bubble laundry facts in the **same** `proposedResponse`.
- **ALWAYS** set `shouldReply: true`.

**Standard laundry facts** (always include these words/facts when LAUNDRY_QUESTION applies):
"We do not have laundry on site, but there is a laundromat next door called Soap Bubble that is very accessible. Address: 68 Pine St, Portland, ME 04102"

**Good examples**:
- Laundry only: "Hi Henry, we do not have laundry on site, but there is a laundromat next door called Soap Bubble that is very accessible. Address: 68 Pine St, Portland, ME 04102"
- Thanks + laundry (Henry): categories `["THANK_YOU_MESSAGE", "LAUNDRY_QUESTION"]` → "You're welcome, Henry! We do not have laundry on site, but there is a laundromat next door called Soap Bubble that is very accessible. Address: 68 Pine St, Portland, ME 04102"
- With first-contact greeting: "Good morning, Henry! You're welcome. We do not have laundry on site, but there is a laundromat next door called Soap Bubble that is very accessible. Address: 68 Pine St, Portland, ME 04102"

**Anti-patterns (do NOT do these)**:
- "I'll check on laundry for you and get back shortly."
- "Let me look into laundry options and get back to you."
- Offering to do laundry or implying there are on-site machines.
- Answering only with "You're welcome" and ignoring the laundry question.
- Classifying as only `THANK_YOU_MESSAGE` when laundry was asked.
- **Contradicting a host-granted laundry exception** in the same thread (Sara incident): never send Soap Bubble / "no laundry on site" after the host said the guest may use the washer/dryer this time.

**Tone**: Brief, warm when they thanked you, then factual.


## Host-granted laundry exception (Sara / Jerome incident — CRITICAL)

If conversation history shows the **host already granted a one-time exception** to use an on-site washer/dryer (e.g. "this is not for guests usually but for this time feel free to use it"), you MUST NOT send the stock "no laundry on site / Soap Bubble" denial. That directly contradicts the host.

**Correct behavior when a host laundry exception is present**:
- Short ack that **honors** the exception (e.g. "Yes — as we said, feel free to use the washer and dryer this time!"), **or** skip reply if the host already fully answered.
- **Never** recommend Soap Bubble or say there is no laundry on site in that same thread after the grant.
- Deterministic traces (`hostLaundryExceptionGranted` / `hostGrantedException`) and the conversation judge will REVISE any Soap Bubble draft that contradicts the grant.

**Anti-pattern (Sara 2026-09 Pineland)**: Host: "feel free to use it!" → Auto-reply seconds later: "we do not have laundry on site… Soap Bubble…" → guest confusion. Do not repeat.

## LAUNDRY_DETERGENT_QUESTION

**When guest asks about detergent / drying sheets**:
- "For laundry, we use Kirkland Brand detergent from Costco, and for drying sheets we use Tide."

**Do not** offer to do laundry or provide on-site machines.
