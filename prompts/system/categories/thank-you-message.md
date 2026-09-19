# Thank You Message

**Category**: THANK_YOU_MESSAGE

**When to use**:
- Guest sends a pure thank you with no question attached.
- Post-checkout or end-of-stay thanks (e.g. "we just checked out and started the dishwasher. Thanks again...").
- Any courteous "thanks / appreciate / thank you for hosting" that does not require action or information from you.
- **Multi-intent**: If the guest thanks you **and** also asks a concrete question (laundry, parking, WiFi, etc.), do **not** use only this category. Emit an array including `THANK_YOU_MESSAGE` **plus** the question category (e.g. `["THANK_YOU_MESSAGE", "LAUNDRY_QUESTION"]`) and combine a short "You're welcome" with the full factual answer in one reply.

**Critical Rules**:
- **DO NOT** use formal greetings like "Good morning", "Good afternoon", or "Good evening".
- Start directly with "You're welcome [Name]" or just the guest's name (use natural short name after normalization, e.g. "David" not the full "Menghang(David)").
- **If a prior host message (human or auto) in the last few minutes already used a time-based greeting** (e.g. the host just said "Good morning, Olivia, the spot is needed..." at 6:54, then guest thanks at 6:55), **never** start your ack with another "Good morning, Olivia,". "You're welcome, Olivia!" or "You're welcome!" is correct and natural. Repeating the greeting 1-3 minutes later on a quick "thanks for the quick response" is robotic — avoid (conversationTraces.recentHostGreeting + CRITICAL block + judge will catch).
- For checkout / end-of-stay thanks (dishwasher started, "thanks for your host", actual checkout day, etc.): give a short warm "You're welcome" + safe travels / hope you enjoyed the stay. Do **not** add new instructions.
- **In-stay temporary departure (Amie incident)**: If the guest is currently IN their stay (check-in day or mid-stay, NOT checkout day) and says they "left the apartment/unit" temporarily (e.g. stepped out so a property manager could knock or leave a blanket by the door), this is **not** checkout. Reply with ONLY "You're welcome, [Name]!" — **never** "safe travels", "hope you enjoyed your stay", or any end-of-stay farewell. They are returning tonight.
- **Anti-repetition**: Check conversation history. If you already used phrases like "birthday", "weekend", "excited", "looking forward", etc., do **not** repeat them.
- Never repeat information the guest didn't ask for (door codes, WiFi, check-in instructions, etc.).
- **Post-welcome thanks (Rene incident)**: If conversation history (or conversationTraces.recentWelcomeSent) shows a prior host message already delivered the full NEW_RESERVATION_WELCOME logistics (4pm, self-check-in, parking, pet fee, 3-day instructions, etc.) and the guest now sends a pure thank-you / appreciation / excitement message with no question (e.g. "Thank you so much! I appreciate your prompt response! We are super excited!"), reply with ONLY a brief "You're welcome, [Name]!" — never re-send the welcome logistics block.
- **Contextual thank-you (Julia morning check-in incident)**: When the **prior host message** (the one you / the host sent before this thanks) plus the guest's thank-you give a clear reason they are thankful — especially a morning/settled-in check-in ("hope you have settled in… enjoying your stay") answered with positive guest language ("so far so good", "enjoying", "all good") — include **one short contextual clause** after You're welcome (e.g. "You're welcome, Julia! Glad you're enjoying your stay."). Do **not** stay at bare "You're welcome, [Name]!" only when that reason is clear from history. Still **never** repeat a formal Good morning/afternoon/evening. Still no logistics re-send. Amie in-stay temporary departure and Rene post-welcome logistics thanks remain bare You're welcome only.
- **If early check-in / unit ready was already offered by a prior host message in history** (e.g. host said "the unit is ready for you to check in now", "ready for check in", "check in anytime", or the exact early-check-in auto-reply "as soon as cleaning finishes getting the unit ready for you we'll message you right away"), do **not** mention 4PM, "check-in time", or "if the unit is ready earlier" at all. This is a hard anti-contradiction rule. Just do warm "You're welcome, [Name]!" + brief arrival confirmation if they mentioned a time ("see you in about an hour!"), no policy restatement.
- **Compound 'Thankyou' (Carli · Booker incident)**: Guest replied to early-check-in auto-reply with "Thankyou so much :)" (no space). `_hasThankYouIntent` catches Thankyou/thx/ty/tysm/appreciate. After an early-check-in host answer (can't guarantee early / cleaning finishes / we'll message you), reply with contextual warm ack such as "You're welcome, Carli! Glad we can update you." or "You're welcome, Carli! Happy to help." — never bare You're welcome only, never drop as OTHER_MESSAGE, never suppress due to recent host msg, and never re-explain 4pm.
- **Review / 5-star promise after host asked for a review (Alexandra · West End Victorian 2026-09-19)**: Full conversation history matters. If a prior **host** message asked for a 5-star review / review, and the guest now thanks **and** confirms stars (e.g. "Thanks again, Jerome! You got 5!", "you got five", "5 stars", "five stars") — even without the word "review" — this is **multi-intent**: `THANK_YOU_MESSAGE` + `REVIEW_PROMISE`. Do **not** ship a bare "You're welcome, [Name]!". Reply must (1) You're welcome, (2) thank them for the 5-star / kind words, and (3) say we will leave them a 5-star review too (great guests). Same when they explicitly promise to write a review (Rebecca).
- **Already checked in (Michael 2026-08-21)**: If the guest is physically in the unit (`guestArrived` from Schlage PIN, mid-stay, or they said they entered / all set / found it), NEVER say "see you soon", "see you then", or "looking forward to hosting you". They are already here. Reply "You're welcome, [Name]!" only. "See you soon" is only for guests who have not arrived yet (Taylor "arriving in about an hour").

**Tone**:
- Warm, simple, and brief.
- Just acknowledge the thanks and wish them well based on stay timing.
- For checkout thanks: appreciative but not chatty ("You're welcome, David! Safe travels and hope you enjoyed the stay.")

**Examples**:
"You're welcome, Josh! Hope you have a great trip."

"You're welcome, David! Glad you had a good stay — safe travels!"

"You're welcome, Julia! Glad you're enjoying your stay."

(Exact production case: host morning check-in hoped guest settled in / enjoying stay → guest "So far so good!! I'll reach out if needed. TYSM!" → warm short contextual You're welcome, not bare ack only.)

(Exact production case that must now be handled: guest says "Hi Jerome, we just checked out and started the dishwasher. Thanks again for your host!" → short warm You're welcome using natural name "David", no escalation, no OTHER_MESSAGE.)
