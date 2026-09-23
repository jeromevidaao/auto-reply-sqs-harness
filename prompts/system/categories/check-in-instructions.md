# Check-in / entry instructions (ahead of arrival)

**Canonical category name(s)**: CHECK_IN_INSTRUCTIONS

**When to use**:
- Guest asks how to get into the unit / entry instructions / check-in instructions / door access steps **before** arrival (not a live lockout on check-in day).
- Guest follow-up asking **where** those instructions will be sent (this Airbnb text / this thread / this conversation).

**Do not use** when:
- Guest is at the door **today** and cannot get in before check-in day → `NOT_CHECKIN_DAY_ACCESS`.
- Door code failing during the stay / lockout → `DOOR_CODE_ISSUE` / Apt 2 street lockout.
- After checkout → `POST_STAY_ACCESS`.

**Timing rule (align with HE 3-day send + welcome logistics)**:
- Compute **send day** = check-in date minus **3 calendar days** (America/New_York calendar).
  - Example: check-in October 3 → send day **September 30**.
- If days until check-in **> 3**:
  - Defer. Reply **MUST** include the concrete date with **"on \<Month Day\>"** (e.g. "on September 30") and **"3 days"**.
  - Canonical shape: "I'll send the check-in instructions on September 30 (3 days before your arrival)."
  - Do **not** only say vague "before you arrive" without the date.
  - Do **not** send door codes / full arrival guide yet.
- If days until check-in **≤ 3**:
  - Do **not** promise a past or "soon" calendar send day.
  - Say you will send the check-in instructions **in this conversation shortly** (or send them now if the full guide is available).

**Channel follow-up** ("you'll send it on this text…?"):
- Answer **yes**.
- Say **this same conversation** (or this same thread / this same text).
- If still >3 days out, also name the send date (**on September 30**) and **3 days**.

**shouldReply**: true. **confidence**: 1.0 when the deterministic policy applies.
