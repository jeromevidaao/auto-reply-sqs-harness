# Golden: Ted away — turn HVAC off remotely (Apt 3)

**Scenario**: After a mixed-mode FYI that already named rooms and said to use the remotes on the wall (no Nest, no unit number), Ted replies that he may have left heat on, they are away, and asks if we can turn it off remotely or leave it.

**Real incident (2026-09-05, reservation `2f6de039-8426-4bad-9de4-1f0e9695361d`)**:
- Host already sent: small bedroom on heat, living room and master bedroom on cool, same-mode rule, remotes on the wall.
- Guest: "Are you able to turn it off remotely or is it ok to leave as is for now"
- Bad auto: Nest + remotes lecture + "let me know the exact settings" — did not turn anything off. Judge did not catch the repeat because it lacked the full thread.

**Approved behavior**:
- HeatPumpTool turns all wall units off.
- Reply confirms **I turned the wall units off**.
- Do **not** mention Nest.
- Do **not** repeat remotes / same-mode (already sent).
- Do **not** mention Apt 3.
- Conversation Judge always receives the **full** chronological thread.

**Rubric**:
- Required: `I turned the wall units off`
- Forbidden: Nest, make sure you are using, Apt 3, Apt 2
- shouldReply: true

Do not re-send on the live thread — host already turned units off and replied.
