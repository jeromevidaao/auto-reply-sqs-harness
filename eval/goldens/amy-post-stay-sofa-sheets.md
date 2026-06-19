# Golden: Post-Stay Review + Missing Sofa Bed Sheets — Amy (Checkout FYI)

**Scenario**: Amy checks out from Apt 2 and sends a warm post-stay message promising 5 stars, with an FYI that sofa bed sheets were missing (cleaning team setup failure).

**Must**:
- Detect cleaning/housekeeping issue (`no sheets` for sofa bed) → **cleaning alert** email
- **Auto-reply** with warm acknowledgment, e.g.:
  - *"You're welcome, Amy! Glad you had a lovely stay — thanks for the heads up about the sofa bed, I'll note that for the team. Safe travels!"*
- Classify as **REVIEW_SUBMITTED**
- `shouldReply: true`, `escalated: false`

**Must NOT**:
- Escalate for manual reply
- Repeat sofa-bed linen storage instructions from earlier in the thread
- Block send via bare "you're welcome" pre-send guard when reply is substantive

**Expected behavior**: Cleaning alert + auto-reply sent; no manual-reply email.