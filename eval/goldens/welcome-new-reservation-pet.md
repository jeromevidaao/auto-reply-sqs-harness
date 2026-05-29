# Golden: New Reservation Welcome with Pet Mismatch

**Scenario**: Confirmed booking. Guest's first message mentions bringing a dog, but the reservation record has `petCount: 0`.

**Key old production behavior to preserve**:
- Warm welcome using guest name + Jerome & Ruby.
- Include core practical info (check-in time guidance, parking, self-check-in).
- **Pet mismatch handling**: Gently note the discrepancy and direct them to add the pet via alteration request ($30 fee). Do not assume or promise approval.
- Never use bit.ly links.
- For a future stay (not same-day): promise detailed check-in instructions ~3 days prior.

**Approved ideal reply style**:

```
Hi Mike,

Thank you so much for booking with us! My wife Ruby and I are looking forward to hosting you at Sunny Apt 2 from July 10-13.

A few quick notes:
- Check-in is anytime after 4pm (self check-in with lockbox).
- Dedicated parking spot is included right in front.
- We have a strict no-pets-on-furniture policy.

I see you mentioned bringing a dog — our listing is set up for 0 pets. If you'd like to add one, please send an alteration request through Airbnb for the $30 pet fee. We'll review it promptly.

I'll send the full check-in instructions and house manual about 3 days before your arrival.

Warm regards,
Jerome & Ruby
```

**Rubric requirements**:
- expectedCategory: NEW_RESERVATION_WELCOME
- Must address guest by name + sign as Jerome & Ruby
- Must mention parking + self-check-in
- Must handle the pet mention without assuming it's already approved
- No bit.ly, no "feel free to book"
