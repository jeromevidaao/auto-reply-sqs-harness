# Not check-in day — guest trying to get in

**Canonical category**: `NOT_CHECKIN_DAY_ACCESS`

**Incident**: Michael, Apt 2, 2026-08-20 ~6:05pm ET. Check-in was **August 21**. He messaged "Hello! Can you please confirm what our apt # is?" while at the building; auto-reply named Apt 2 as if he could enter. Jeffrey was still in Apt 2 until the 21st. Door PIN had been programmed the day before. He later wrote "Looks our reservation isn't until tomorrow, whoops!"

**Rule**: If today (America/New_York) is **before** the reservation check-in date **and** the guest is asking about access (can't get in, door code, apt #, at the door / arrived):

- Tell them **today is not your check-in day**.
- State the check-in **date** and **4pm**.
- Say the **door code is not on the lock until the morning of your arrival**.
- You may name the unit for when they return. Do **not** give backup door codes, lockbox codes, or lockout recovery.
- Do **not** treat this as `DOOR_CODE_ISSUE` or `APT2_STREET_DOOR_LOCKOUT`.
- Schlage PINs are programmed at **5:00 AM ET on check-in day** (Airbnb and HomeExchange).

This is distinct from `EARLY_CHECKIN` (asking to arrive before 4pm **on** check-in day).
