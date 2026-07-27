# Golden: Apt 2 Street Door Lockout (bolted parking door)

**Scenario**: Guest at Apt 2 (Henry) accidentally locked/bolted the parking-side door from the inside, exited toward the street, and cannot re-enter. Keypad codes alone will not help.

**Real production value**: Distinct from generic `DOOR_CODE_ISSUE` (backup 1028) and from Apt 3 lockbox. Wrong historical reply was only "try code 8040".

**Approved ideal behavior**:
- Category: `APT2_STREET_DOOR_LOCKOUT`
- Street entrance: two lock boxes on the right; **top** box code **{{APT2_STREET_LOCKBOX_CODE}}**; put key back immediately
- Unit pin = last 4 of phone (when known)
- Escalation phones: Jerome, Ruby, Richard
- Auto-reply **and** urgent SNS SMS to hosts

**Rubric requirements**:
- expectedCategory: APT2_STREET_DOOR_LOCKOUT
- Must include {{APT2_STREET_LOCKBOX_CODE}}, lock box / top, pin/phone digits, and host contact numbers
- Must not only tell them to try the outside door code as if that opens a bolted door
