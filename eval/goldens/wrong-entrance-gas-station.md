# Golden: Wrong Entrance (Gas Station Path) - Real Production Scenario

**Scenario**: Guest arrives at the front of the building for Sunny Apt 2 instead of the actual entrance at the back near the parking area (path between the building and gas station).

**Real production value**:
- This was a recurring issue with real guests.
- The old code had very specific, tested directions for this exact situation.
- Poor directions here lead to bad first impressions and support load.

**Approved ideal behavior**:
- Clear, calm redirection.
- Specific landmarks (gas station, parking area, back of building).
- Use guest name.
- Keep it short and actionable.

**Rubric requirements**:
- expectedCategory: CHECKIN_LOCATION_GUIDANCE or similar
- Must direct guest to the back near parking/gas station path
- Must NOT suggest the front has a lockbox for this property
