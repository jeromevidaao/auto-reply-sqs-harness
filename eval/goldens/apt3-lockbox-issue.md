# Golden: Apt 3 Lockbox Issue - Property Specific

**Scenario**: Guest at Apt 3 (the only unit with a physical lockbox) has trouble with it.

**Real production value**: Apt 3 is handled differently from 1B/Apt 2 (which use keypads at the back). Old code had a dedicated apologetic response for lockbox problems at Apt 3.

**Approved ideal behavior**:
- Apologetic and helpful tone.
- Specific troubleshooting for Apt 3 lockbox.

**Rubric requirements**:
- expectedCategory: APT3_LOCKBOX_ISSUE
- Must not use the "front of building" redirection language (that's for other units)
