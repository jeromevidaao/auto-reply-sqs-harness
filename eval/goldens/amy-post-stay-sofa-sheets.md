# Golden: Post-Stay Review + Missing Sofa Bed Sheets — Amy (Checkout FYI)

**Scenario**: Amy checks out from Apt 2 and sends a warm post-stay message promising 5 stars, with an FYI that sofa bed sheets were missing (cleaning team setup failure).

**Must**:
- Detect cleaning/housekeeping issue (`no sheets` for sofa bed)
- Trigger **cleaning alert** email
- **Escalate** for manual reply (`shouldReply: false`, `proposedResponse: none`)
- Classify as **REVIEW_SUBMITTED** or **OTHER_MESSAGE** (not SLEEPING_ARRANGEMENTS / THANK_YOU_MESSAGE)
- **Must NOT** auto-reply with "You're welcome" or repeat sofa-bed linen location instructions

**Must NOT**:
- Treat as post-welcome thank-you follow-up (Rene flow)
- Send a generic short ack — Jerome must reply personally thanking Amy and acknowledging the sheets issue

**Expected behavior**: No auto-reply; cleaning alert + manual-reply escalation emails sent.