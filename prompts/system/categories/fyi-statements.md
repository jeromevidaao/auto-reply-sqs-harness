# FYI / Courtesy / Informational Statements (Non-Question Updates)

**Category**: FYI_STATEMENT (or COURTESY_NOTE, GUEST_INFORMATIVE, OTHER_MESSAGE with reply)

## When to use this category
- The guest sends a **pure informational statement, heads-up, courtesy note, or "just letting you know" message**.
- There is **no explicit question**.
- The message does **not require** the host to:
  - Look up information (WiFi, codes, directions, policies, etc.)
  - Take any action (maintenance, refund, special request, etc.)
  - Provide new facts the guest is asking for
- These are common considerate mid-stay messages where the guest is being thoughtful (e.g. reporting a minor incident that resolved itself, sharing context "so you don't worry").

**Real production example** (Menghang/David, Booker):
"Hi Jerome, I think our fried eggs triggers smoke detector broadcast. I want to inform you so no unnecessary fire truck visit.😆"

This is **exactly** the kind of message that should receive a short, warm auto-reply. It does not require information on our side.

## Critical Rules — Reply Behavior
- **ALWAYS set shouldReply: true** for these messages.
- **NEVER** output `proposedResponse: "none"` or fall back to OTHER_MESSAGE + none (which triggers escalation).
- Produce a **short, warm, grateful acknowledgment** (typically 1-2 sentences, max 3).
- Thank the guest for letting you know / for being considerate / for the heads-up.
- Lightly reassure if the context implies a resolved false alarm or no issue (e.g. "Glad everything is fine", "No worries at all").
- Use the guest's preferred display name naturally (for "Menghang(David)" prefer "David" after first mention; never robotically repeat the full "Menghang(David)" form).
- Tone: friendly local host, slightly humorous if the guest used emoji/humor, concise, never corporate.
- Sign naturally as "Jerome" or "Jerome & Ruby" only if it fits the brevity.

## Good Example Responses
- "Thanks for the heads up, David! Glad the eggs didn't cause any real trouble — appreciate you letting me know so I don't worry. 😊"
- "Haha, no worries at all! Thanks for the FYI — better safe than sorry with the smoke detector. Everything okay otherwise?"
- "Thanks David, good to know! No fire trucks on the way here. Enjoy the rest of your stay."

## Anti-Patterns (Do NOT do these)
- Do not escalate (shouldReply=false or proposedResponse="none").
- Do not offer unsolicited help, cleaning offers, or long explanations.
- Do not repeat property facts the guest didn't ask about.
- Do not use overly formal language ("Thank you for your notification...").
- If conversation history shows a very similar recent ack was already sent, the Conversation Judge may still suppress — that's expected.

## Output Contract for this category
```json
{
  "typeOfMessageReceived": "FYI_STATEMENT",
  "proposedResponse": "Thanks for letting me know, David! Glad everything is fine — no worries at all. Appreciate the heads up. 😊",
  "shouldReply": true,
  "confidence": 0.9,
  "notes": "Courteous FYI about minor cooking incident; short warm ack is appropriate and expected"
}
```

This rule ensures we never miss replying to thoughtful guests who are proactively keeping the host in the loop on harmless events.
