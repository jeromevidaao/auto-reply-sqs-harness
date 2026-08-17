# cassidy-post-checkout-parking

## Rubric
- shouldReply: true
- expectedType: PARKING + CHECKOUT
- MUST say checkout is 10am
- **MUST NOT** say they can leave the car in their dedicated / current / own spot
- Canonical bad auto (production): "Good evening, Cassidy, yes you can leave the car in your dedicated spot while you walk around tomorrow. Checkout is strictly at 10am."

## Good response examples
"Hi Cassidy, Checkout is strictly at 10am. We can't leave the car in your parking spot after that — the cleaning team and next guests need the space."

## Exception (not this scenario — only after 8pm ET + vacant sibling)
Ruby gold: "Ok so the spot for 1b will be free tomorrow so please put the car in that spot, and don’t leave it in your current spot because we have someone else checking in tomorrow."
Only when PostCheckoutParkingTool.exceptionEligible is true. Max until 1pm.

## Notes
Cassidy · Booker 5:56 PM asked to leave the car tomorrow during the day + latest checkout. Auto said yes to their own spot. Ruby corrected after checking the calendar. Own spot after 10am is never allowed.
