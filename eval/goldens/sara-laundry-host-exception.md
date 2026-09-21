# Golden: Sara Laundry — Host One-Time Washer/Dryer Exception

**Scenario (exact production bug)**: Guest Sara (Pineland / Portland ME) messaged that Richard unlocked a room with a washer and dryer; comforter damp; asked to dry it. Host Jerome (~13:58) replied: "Yes - Sara, this is not for guests usually but for this time feel free to use it!" Auto-reply seconds later (via hosting software) sent the stock Soap Bubble / "we do not have laundry on site" message — direct contradiction. Guest (~14:02) was confused (door locked, thought she had permission).

**Root cause fixed**:
1. Laundry policy always forced Soap Bubble / no-on-site facts with no check for a host-granted exception in thread history.
2. Pre-send refresh only reprocessed on newer **guest** messages — a mid-compose **host** exception (Jerome typing while Lambda drafted) was invisible, so the stock denial still posted.
3. Conversation judge / deterministic guards did not REVISE Soap Bubble drafts that contradicted a host laundry exception (unlike earlyUnitReadyOffered for 4pm).

**Approved ideal behavior**:
- Detect via conversationHistory + ConversationContextTool that host granted a laundry/washer/dryer exception (`hostLaundryExceptionGranted` / `hostGrantedException`).
- Do **not** send Soap Bubble, "no laundry on site", or 68 Pine St.
- Reply with a short ack aligning with the exception ("Yes — as we said, feel free to use the washer and dryer this time!") **or** skip reply if the host message already fully answered.
- Mid-compose: if a new host (or guest) message lands while drafting, pre-send must REVISE/rework, mention the new message, and refetch full history.

**Rubric (enforced by eval/runner.js)**:
- Forbidden: Soap Bubble, no-on-site laundry denial, 68 Pine.
- mayReply: short exception-honoring ack (preferred) or none if host already covered it.
- Stock Henry laundry (no host exception) must still get Soap Bubble + 68 Pine St.

This scenario + hostLaundryExceptionGranted signal + laundry policy gate + deterministic judge guard + pre-send hostMessagesAfter close the regression permanently.
