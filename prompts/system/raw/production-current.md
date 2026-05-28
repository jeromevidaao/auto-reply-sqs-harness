# Production System Prompt — Raw Import (from full Lambda source)

**Source**: User pasted the full current `auto-reply-sqs` Lambda code (index.js) on 2026-05-28

**Note**: The user provided the entire Lambda source. The actual Grok system prompt lives inside this file as the large `systemInstruction` template literal.

**Next step**: I will extract the clean system prompt text from the `systemInstruction` variable below and save a pure-text version.

---

## RAW LAMBDA SOURCE RECEIVED

```javascript
{{PASTE_START}}
Herconst { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
... [full 145k+ character Lambda source as provided by user] ...
{{PASTE_END}}
```

## EXTRACTED SYSTEM PROMPT (to be populated next)

The actual prompt text that gets sent to Grok starts after:

```js
const systemInstruction = `
You are a helpful Airbnb host in Portland, Maine. Your name is Jerome.
...
```

I will now parse and save the clean prompt text.
