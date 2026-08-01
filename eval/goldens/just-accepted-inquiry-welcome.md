# Golden: Just Accepted Inquiry Welcome

**Scenario**: Guest had a request-to-book (pending). Host clicks Accept. Reservation lifecycle webhook shows request → accepted within ~5 minutes.

**Approved behavior**:
- Category: NEW_RESERVATION_WELCOME
- shouldReply: true
- Opens with **"I just accepted your inquiry"** (after optional Good morning/afternoon + name)
- Then normal rich welcome: 4pm, self-check-in, parking, 3-day instructions when applicable
- Never "feel free to book"

**Instant book**: Do not use this opener when history is accepted-only (no prior request/pending).

**Example shape**:
> Good afternoon, Dashiell, I just accepted your inquiry. Welcome! Check-in is at 4pm with self-check-in and one dedicated off-street parking spot. I will send the detailed check-in instructions 3 days before your arrival. ...
