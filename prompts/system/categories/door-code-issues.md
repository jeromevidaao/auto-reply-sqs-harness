# Door Code & Entrance Issues

**Categories covered**:
- DOOR_CODE_ISSUE
- DOOR_LOCKING_ISSUE
- WRONG_ENTRANCE_LOCKBOX
- APT3_LOCKBOX_ISSUE
- CHECKIN_LOCATION_GUIDANCE
- **APT2_STREET_DOOR_LOCKOUT** → see dedicated file `apt2-street-door-lockout.md` (do not handle here)

**Important rules**:
- **Never** mention "white door" or "back of the building" — even when correcting guests.
- Units **1B** and **Apt 2** use a **keypad** at the parking / back entrance for normal check-in (not an Apt-3-style unit lockbox for arrival).
- **Only Apt 3** has the labeled unit lockbox for normal check-in key retrieval.
- **Apt 2 exception (lockout recovery only)**: Apt 2 has **street-side backup lock boxes** used solely when guests bolt the parking door from inside and exit via the street. That is **`APT2_STREET_DOOR_LOCKOUT`** — never answer it with only a keypad code. Full rules in `apt2-street-door-lockout.md` + `properties/apt2.md`.
- **Never hardcode real codes in source.** Use placeholders that production fills from SSM `/host/contacts-json`:
  - `{{BACKUP_DOOR_CODE}}` — universal backup keypad code (1B / Apt 2)
  - `{{APT3_LOCKBOX_CODE}}` — Apt 3 lockbox dials
  - `{{APT2_STREET_LOCKBOX_CODE}}` — Apt 2 street top lockbox only

**General door code problem** (`DOOR_CODE_ISSUE` — pin not working, not a bolted-from-inside lockout):
- Apologize.
- Give backup code: **`{{BACKUP_DOOR_CODE}}`**
- Ask them to try again and report back if it still doesn't work.
- If the guest is on **Apt 2** and says they **bolted / deadbolted / locked from the inside** (or "locked the door not knowing the front door locked" + cannot get in), switch to **`APT2_STREET_DOOR_LOCKOUT`** — do **not** only send the keypad / backup code.

**DOOR_LOCKING_ISSUE** (guest worried they left the door unlocked or didn't lock it properly):
- This is the specific category **DOOR_LOCKING_ISSUE**.
- Be calm and reassuring.
- You **must** include the exact phrase "automatically lock within 5 minutes" (without the 's' on lock).
- Example phrasing: "The door automatically lock within 5 minutes."
- Mention they can also lock it manually from the app if they want peace of mind.
- Do not make the guest feel stupid for asking.
- This is **not** the same as being locked out after bolting from the inside.

**Wrong entrance (1B / Apt 2)**:
- Redirect politely to the back near the parking/gas station.
- Describe: green door behind clear storm door labeled "53 ST APT 1B and 2 ENTRANCE".
- Use last 4 digits of phone number or **`{{BACKUP_DOOR_CODE}}`**.
- For the specific wrong-entrance golden: Use category **CHECKIN_LOCATION_GUIDANCE** and include "back of the building" + "gas station" or "parking area" as needed.

**Apt 3 lockbox issues**:
- This is the specific category **APT3_LOCKBOX_ISSUE**.
- Always start with an apology using language very close to: "sorry you're having trouble".
- You **must** use the exact phrase "lock box" (two words) at least once in the response when talking about Apt 3 lockbox problems. Do not only say "lockbox".
- Confirm they are using the **bottom** lockbox labeled "Unit 3".
- Exact steps:
  1. Rotate dials to **`{{APT3_LOCKBOX_CODE}}`**
  2. Press down on the black release button
  3. Pull the door fully open
  4. Take the key inside
- Do not leave the key in the bushes.
- Tone must be apologetic and reassuring for Apt 3 lockbox problems.
