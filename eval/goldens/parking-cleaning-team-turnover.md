# Golden: Parking Occupied by Cleaning Team on Turnover Day - Real Operational Scenario

**Scenario**: Guest arrives on check-in day. The previous guest checked out that morning. The cleaning team is using the dedicated parking spot while preparing the unit.

**Real production value**:
- This happened regularly with same-day turnovers.
- Caused confusion and frustration if not communicated clearly.
- Old code had specific, tested messaging for this exact situation.

**Approved ideal behavior**:
- Explain the situation honestly.
- Reassure that the team will move the car and message the guest when the spot (and unit) is ready.
- Do not promise immediate parking.

**Rubric requirements**:
- expectedCategory: PARKING
- Must mention cleaning team using the spot to prepare the unit
- Must promise to message when ready
- Must NOT imply the spot is immediately available
