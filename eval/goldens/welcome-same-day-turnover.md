# Golden: New Reservation Welcome on Same-Day Turnover

**Scenario**: Guest is arriving the same day a previous guest checked out. The unit is not yet ready.

**Key old production behavior to preserve**:
- Do not give the generic "check in after 4pm" or "the apartment is ready" language.
- Accurately reflect that the unit is being prepared and the host will message the guest when it is ready.
- Maintain warm tone while being precise about readiness.

**Approved ideal behavior**:
- Warm welcome.
- Clearly communicate that the unit is still being prepared due to same-day turnover.
- Promise to message when ready.
- No over-promising on exact early check-in time.

**Rubric requirements**:
- expectedCategory: NEW_RESERVATION_WELCOME
- shouldReply: true
- Must mention preparation / will message as soon as it's ready
- Must NOT say the unit is already ready or give standard 4pm check-in as the only option
