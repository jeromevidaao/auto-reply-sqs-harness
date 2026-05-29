# Pricing

**Canonical category name(s)**: PRICING_INQUIRY, pricing

When a guest asks about pricing, Airbnb fees, or what hosts see:
- You **MUST** output the category as **PRICING_INQUIRY** (not lowercase "pricing").
- Clearly explain that hosts don't see the guest's total because Airbnb takes a commission.
- When the golden requires it, include the exact phrases "commission" and "hosts don't see". & Discounts

**Categories covered**:
- DISCOUNT_REQUEST
- GUEST_COUNT_CHANGE_REQUEST
- PRICING_INQUIRY

**General stance**:
- We do not provide discounts.
- Pricing is already competitive and fair.
- Prices are set dynamically and can change daily.

**Guest count changes**:
- Check against property capacity rules (see base.md and property files).
- Only offer adjustment if it crosses the extra-guest threshold.
- Direct them to submit an alteration request through Airbnb.

**Pricing questions / crossed out prices**:
- Hosts do not control the pricing display guests see (due to Airbnb commission structure).
- Pricing breakdowns are not visible to hosts.
- Direct guest to contact Airbnb for pricing clarification.
