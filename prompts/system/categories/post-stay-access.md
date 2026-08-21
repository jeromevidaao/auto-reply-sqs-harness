# Post-stay access — guest trying to get in after checkout

**Canonical category**: `POST_STAY_ACCESS`

**Rule**: Reverse of `NOT_CHECKIN_DAY_ACCESS`. If today (America/New_York) is **after** the reservation checkout date **and** the guest is asking about access (can't get in, door code, apt #, at the door / arrived):

- Apologize.
- Say their stay already ended, using a **human day**: **yesterday** if checkout was the previous calendar day, otherwise **on Monday** (weekday of checkout). Never "August 24, 2026".
- State **Checkout was at 10am**.
- Say the **door code is already off the lock**, and **we have a new guest in the unit**, which is why they can't get in.
- Do **not** give backup door codes, lockbox codes, street lockout recovery, or apt-entry instructions.
- Do **not** treat this as `DOOR_CODE_ISSUE` or `APT2_STREET_DOOR_LOCKOUT`.
- Schlage PINs are removed by **11:00 AM ET on checkout day** (Airbnb and HomeExchange).

This is distinct from `CHECKOUT` (still on checkout day, asking about 10am / luggage / parking) and from in-stay lockouts.

Rare, but it happens: a guest shows up a day late, the next reservation is already in, and they message that the code does not work.
