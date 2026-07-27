# Apt 2 Street Door Lockout (bolted parking door)

**Category**: `APT2_STREET_DOOR_LOCKOUT`

**Scope — extremely narrow**:
- **Only** Sunny Apt 2 / listing `114663c5-0709-4eff-a868-fa9ebd6ed42d`.
- **Never** use for 1B, Apt 3, wrong-entrance guidance, normal door-code failures, or "did I lock the door?" anxiety (`DOOR_LOCKING_ISSUE`).

## The real-world failure mode (Henry incident)

Apt 2 has **two** exits:
1. **Main / parking entrance** (the one in the check-in instructions) — keypad pin entry.
2. **Street entrance** — stairs down to the street. Guests sometimes exit this way.

If guests **bolt / deadbolt the parking-side unit door from the inside** and then leave via the street door, they can get **locked out**. The street door may open from inside without a key, but they **cannot re-enter** without a physical key for the street door. Giving only the keypad pin or backup code (`{{BACKUP_DOOR_CODE}}`) **does not help** — the unit door is bolted from the inside.

Canonical guest wording (use this category):
- "We accidentally locked the door not knowing that the front door locked and are unable to get into the Airbnb."
- Follow-up: "We bolted the door from the inside"
- Variants: bolted, deadbolt, locked from the inside, locked out after exiting the street / front door

## Anti-patterns (FORBIDDEN)

- **Do not** reply with only the outside/unit code (guest last-4, `{{BACKUP_DOOR_CODE}}`, or similar) as if that opens a bolted door.
- **Do not** treat this as generic `DOOR_CODE_ISSUE`.
- **Do not** redirect as wrong-entrance / gas-station path only.
- **Do not** use this category for Apt 3 lockbox or 1B.

## Required reply content

1. Brief apology / acknowledge lockout.
2. Street entrance: on the right, **two lock boxes**; the **top** one has the backup key.
3. Open top lock box by rotating digits to **`{{APT2_STREET_LOCKBOX_CODE}}`**.
4. Open the street door with the key, then **put the key back in the lock box right away**.
5. Up the stairs: enter the unit with **their pin code** = last 4 digits of the phone number on their reservation (use the actual digits when known; otherwise say "last 4 digits of the phone number on your reservation").
6. If still stuck, call:
   - Jerome: **{{HOST_JEROME_PHONE}}**
   - Ruby: **{{HOST_RUBY_PHONE}}**
   - Richard: **{{HOST_RICHARD_PHONE}}**

## Operational side effect

This is **urgent**. The agent also triggers SNS SMS (`notifyUrgentAccessIssue`) for Jerome + Ruby so a human can help immediately if the guest is still stuck.

## Example reply shape

"Sorry you're locked out! On the street entrance door on the right, you will see two lock boxes. The one at the top has the backup key — open it by rotating the digits to {{APT2_STREET_LOCKBOX_CODE}}. Once you open the street door, put the key back in the lock box right away. After you go up the stairs, use your pin code (XXXX / the last 4 digits of the phone number on your reservation) to enter the unit. If you have any trouble, call me at {{HOST_JEROME_PHONE}}, my wife Ruby at {{HOST_RUBY_PHONE}}, or Richard at {{HOST_RICHARD_PHONE}}."
