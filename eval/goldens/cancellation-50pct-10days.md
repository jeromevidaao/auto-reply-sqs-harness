# Golden: Cancellation - 50% refund case (10 days out)

**Scenario**: Guest booked ~25 days ago, wants to cancel 10 days before check-in (after the 24h full-refund window but still 7+ days out).

**Key old production behavior to preserve**:
- Correctly calculate and state the 50% refund (including taxes).
- Clearly explain *why* (timing relative to booking and check-in).
- Always link to the official Airbnb policy page.
- Firmly state that the guest must initiate the cancellation themselves on Airbnb.
- Do **not** offer to cancel on their behalf or promise a different amount.

**Approved ideal reply style** (from production):

```
Hi Sarah,

I'm sorry to hear your plans have changed.

Because you booked more than 24 hours ago and your check-in is more than 7 days away, you would receive a 50% refund (including taxes) if you cancel now.

You can cancel directly through your Airbnb reservation. For the official policy details, see: https://www.airbnb.com/help/article/475

Please let me know if you have any other questions.

Warm regards,
Jerome & Ruby
```

**Rubric requirements** (enforced in eval):
- Category: CANCELLATION_POLICY
- Must mention "50%"
- Must link to article 475
- Must NOT say "full refund" or offer to cancel for the guest
- Must be clear and direct (no hedging that contradicts policy)
