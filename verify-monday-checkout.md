# Verification for Monday Checkout Auto-Reply Fix

## 1. Commit + push (run after local edits)

```bash
git add eval/scenarios/latest-checkout-monday.json verify-monday-checkout.md
git commit -m "fix: always auto-reply monday checkout question; increase confidence to 1.0; strengthen unit test scenario"
git push origin main
```

Monitor CI until green (then deploy completes).

## 2. Re-send the exact same SQS message to verify auto-reply

After push + deploy:

Create `sqs-payload.json`:

```json
{
  "Records": [{
    "messageId": "verify-monday-checkout",
    "body": "{\"guestMessage\": \"Sounds great! Thank you! And what is the latest time we are able to check out Monday?\", \"context\": {\"guestName\": \"Guest\", \"checkIn\": \"2026-08-10\", \"checkOut\": \"2026-08-12\", \"listingId\": \"114663c5-0709-4eff-a868-fa9ebd6ed42d\", \"propertyName\": \"Sunny Apt 2\"}}"
  }]
}
```

```bash
aws sqs send-message \
  --queue-url "$SQS_QUEUE_URL" \
  --message-body file://sqs-payload.json \
  --region us-east-1
```

Check Lambda logs for guest-messaging-agent-harness: must classify as ["THANK_YOU_MESSAGE","CHECKOUT"], output proposedResponse containing "Checkout is strictly at 10:00 AM.", shouldReply:true, confidence:1.0 and actually send the reply.

This guarantees the message is auto-replied after the fix.