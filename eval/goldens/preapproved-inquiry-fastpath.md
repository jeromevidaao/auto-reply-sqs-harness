# Golden: Pre-approved Inquiry - Fast Path Behavior

**Scenario**: An inquiry that the host has already pre-approved, and the guest is responding positively with no recent host messages in between.

**Expected multipass behavior**:
- Early trace enrichment should detect the pre-approval.
- The first LLM pass should receive a strong signal (`preApprovedInquiry: true`).
- Result: Confident, warm welcome without unnecessary hedging or escalation.

**Rubric requirements**:
- expectedCategory: NEW_INQUIRY_WELCOME
- shouldReply: true
- Must feel confident and welcoming (no phrases suggesting the host still needs to decide)
