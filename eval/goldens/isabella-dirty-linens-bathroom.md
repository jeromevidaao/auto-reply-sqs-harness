# Golden: Isabella Dirty Linens → Bathroom Floor (checkout disposition)

**Scenario**: Isabella (booker) at Cozy West End Victorian / Pine Apt 2, stay Sep 23–26 2026. On checkout morning she asks: "Are we to change the linens? Where should we put the dirty ones?" Earlier the host/auto-reply already explained chaise sofa storage for *clean* extra towels/linens and attached a photo. Harness skipped; Ruby (co-host) replied manually.

**Approved ideal behavior**:
- Recognize as **CHECKOUT** (dirty linen disposition) — **not** EXTRA_LINENS_TOWELS.
- Tell them to **strip** the dirty linens and leave used sheets and towels on the **bathroom floor**.
- Warm tone like Ruby is fine ("if you can strip… that would be great… thank you").
- **Must reply** (shouldReply true, high confidence).
- **Must not** answer only by re-sending chaise / sofa lift-up storage (anti-repetition / wrong intent).
- **Must not** say linen closet / bathroom sink for dirty placement.

**Rubric requirements**:
- Must reply.
- Must include "bathroom floor" and "strip".
- Must not say "manual reply needed", linen closet, or bathroom sink.

**Example of good output**:
"Hi Isabella, if you can strip the dirty linens that would be great — please leave the used sheets and towels on the bathroom floor. Thank you!"

**Why this golden exists**:
- Locks checkout dirty-linen disposition after the Isabella skip.
- Separates dirty disposition (bathroom floor) from clean-extras find-more (chaise sofa).
