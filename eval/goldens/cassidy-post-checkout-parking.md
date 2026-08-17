# cassidy-post-checkout-parking

## Rubric
- shouldReply: true
- expectedType: PARKING + CHECKOUT
- MUST say checkout is 10am
- MUST explain why: cleaning team needs that spot to clean the unit and get it ready for the next guests
- **MUST NOT** say they can leave the car in their dedicated / current / own spot
- Canonical bad auto (production): "Good evening, Cassidy, yes you can leave the car in your dedicated spot while you walk around tomorrow. Checkout is strictly at 10am."

## Good response examples
"Hi Cassidy, Checkout is strictly at 10am. We can't leave the car in your parking spot after that because the cleaning team needs that spot to clean the unit and get it ready for the next guests."

## Exception (not this scenario — only after 8pm ET + vacant sibling)
Name the specific spot: "1B parking spot" / "Apt 2 parking spot" / "Apt 3 parking spot", until 1pm, and still give the cleaning-team reason. Do not leave the car in the current spot.
Only when PostCheckoutParkingTool.exceptionEligible is true.

## Notes
Cassidy · Booker 5:56 PM asked to leave the car tomorrow during the day + latest checkout. Auto said yes to their own spot. Ruby corrected after checking the calendar. Own spot after 10am is never allowed.
