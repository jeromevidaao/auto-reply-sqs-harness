# Golden: NEW_RESERVATION_WELCOME for Cheryl (Downtown Studio — history fetch failed)

**Scenario**: Real production escalation. Cheryl's first post-booking message for Downtown Studio (1B). Pure intro about visiting with daughter + friend, first time in Portland, chose place for walkability. `historyFetchFailed: true` / `live_fetch_failed` with `recentMessageCount: 0` incorrectly caused `shouldReply: false` despite correct `NEW_RESERVATION_WELCOME` classification.

**Must**:
- expectedCategory: `NEW_RESERVATION_WELCOME`
- shouldReply: true
- Rich welcome with 4pm, self-check-in, parking, "detailed check-in instructions 3 days before"
- Greeting + "Cheryl"

**Example good reply**:
"Good morning, Cheryl, thanks for the note — how wonderful that you're visiting Portland with your daughter and her friend, and that walkability was a big reason you chose our place! We have one dedicated off-street parking spot. Check-in is at 4pm with self-check-in. I will send the detailed check-in instructions 3 days before your arrival.

Looking forward to hosting you!"