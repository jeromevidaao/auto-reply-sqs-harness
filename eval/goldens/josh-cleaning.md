# Golden: Josh Cleaning Complaint (May 2026)

**Scenario**: Post-stay feedback about hair in shower and stained ceiling tiles at 53 Pine #1B.

**Expected behavior**:
- Detect as cleaning issue (via CleaningIssueTool)
- Trigger dedicated `🧹 CLEANING ISSUE ALERT`
- Also escalate normally (OTHER_MESSAGE + none from LLM)
- Do **not** mention bean bag rules (this unit doesn't have them)

**Ideal structured output from agent** (example):

```json
{
  "typeOfMessageReceived": "OTHER_MESSAGE",
  "proposedResponse": "none",
  "shouldReply": false,
  "cleaningIssueDetected": true,
  "escalated": true
}
```

**Key points for evaluation**:
- Cleaning detection must fire
- Separate high-visibility cleaning alert must be generated
- No incorrect property-specific rules mentioned (especially bean bags)
- Escalation contains reservation details + direct Airbnb link
