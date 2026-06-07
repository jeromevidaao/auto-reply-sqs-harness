# olivia-car-spot-thanks

## Rubric
- shouldReply: true
- expectedType: THANK_YOU_MESSAGE (or array including it)
- MUST contain a warm short acknowledgment using "You're welcome" (requiredPhrases)
- MUST use the guest's natural name "Olivia" naturally (e.g. "You're welcome, Olivia!" or "You're welcome, Olivia. Safe travels!")
- **MUST NOT** contain any forbidden time-greeting on this reply: no "Good morning, Olivia", "Good morning,", "Good afternoon, Olivia" etc. (the prior host message at 6:54 already used "Good morning, Olivia,"; repeating it ~2 min later on the thanks is the bug)
- Tone: brief, warm, natural, not robotic. This is a pure quick thanks/ack after a human host already handled the car-spot question.
- conversationTraces (when present) should reflect recentHostGreeting + small recentHostGreetingMinutesAgo (~2) from the 6:54 host message.
- Judge (when exercised via --reflection) must detect the repeated greeting style (rule 3) and require REVISE to the minimal ack without the time opener.

## Good response examples
"You're welcome, Olivia!"

"You're welcome, Olivia. Safe travels!"

"You're welcome! Hope the rest of your trip goes well."

## Bad response (the production bug)
"Good morning, Olivia, You're welcome!"

"Good morning, Olivia, no problem at all!"

(The first host message of the session/day *should* have used the greeting; the immediate 2-min follow-up must not.)

## Notes
Exact user-provided incident (6:53–6:56 AM). The regression scenario provides the prior host greeting in conversationHistory so the ConversationContextTool scan + recentHostGreeting signal + CRITICAL ANTI-REPETITION block + thank-you rules + judge can all fire. This protects against the "we said Good morning twice in a row 2 minutes apart" robotic pattern on rapid thanks after a human host reply. Pairs with the Taylor (anti-contradiction) and Kathryn (anti host-advice duplication) guards. All per AGENTS.md requirement to add regression coverage for new repetition classes.
