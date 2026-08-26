# Golden: John second-car parking is not an event request

**Scenario**: Guest mentions a niece's wedding as the reason they are visiting Portland, then asks where a second car can park.

**Real production value**: Production classified this as EVENT_REQUEST because of "celebration" and sent the no-events decline. The guest was only asking about a second vehicle.

**Approved ideal behavior**:
- Category PARKING_ADDITIONAL_QUESTION, not EVENT_REQUEST.
- Say we only have on-site parking for one car.
- Direct the extra car to 192-234 Vaughan Street / SpotHero.

**Rubric requirements**:
- Must include "on-site parking for one car"
- Must mention Vaughan Street and 192-234
- Must not decline events or gatherings
