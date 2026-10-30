# Direct Bun API

Use `await import("<skill-dir>/scripts/sessions.mjs")` in Bun MCP. Importing performs no session access, output or CLI execution. The files are ESM `.mjs`; Bun can import them from TypeScript too.

```js
var { createSessions } = await import("<skill-dir>/scripts/sessions.mjs");
var sessions = createSessions(); // optional { configDir: "/absolute/claude-config" }
var listed = await sessions.list({ noPreview: true });
```

Pin the intended recipient's exact `id` and `pid` from a fresh list, then:

```js
var opened = await sessions.open({ id, pid, name: "OpenCode · review" });
var channel = opened.channel, cursor = opened.cursor;
await sessions.send({ channel, text: "Report the review progress." });
var answer = await sessions.wait({ channel, after: cursor, until: "reply", timeout: 20 });
cursor = answer.cursor;
console.log(answer);
```

Retain `sessions`, `channel` and `cursor` across Bun calls. Keep the library wait timeout shorter than the MCP tool timeout: a tool timeout may destroy its Bun context and receiver. Print the handle/cursor when they change so a surviving channel can be recovered after context loss. Reuse only the Bun session ID actually returned by the MCP.

Methods: `list`, `read`, `open`, `send`, `wait`, `status`, `channels`, `close`. Each accepts one object; parameters and result objects match the CLI. Use numeric values directly and camelCase `noPreview`, `maxChars`, `senderMode`, `messageId`, `replyTtl`. `send({text: "-"})` sends a literal dash; direct imports never read stdin. Config is fixed per client; independent calls can run concurrently without changing `process.env`.

`createSessions` is the public composition interface. Other module exports are implementation internals; do not replace validation callbacks or construct raw socket frames to work around an API failure.

Wait outcomes, including timeout and terminal receipts, return as data without changing the host exit code. Transport/argument failures throw an error with `code` and any recovery handle. Inspect `answer.reply` and `answer.receipts` using SKILL.md's rules. After timeout, continue from the returned cursor without resending. A correlated terminal receipt ends that message; do not loop waiting for its answer.

For multiple expected replies, loop over `wait` and advance the cursor. Independent channels can use `Promise.all`; keep one cursor owner per channel because concurrent reads can replay the same events. Replies are not automatically correlated to individual sends. Do not implement automatic retries with fresh message IDs.

Close with `await sessions.close({ channel })` when the conversation is finished. For a whole conversation within one Bun call use `try/finally`; when continuing across calls retain the channel until the final call. Do not reset/delete the Bun context before closing its channels. CLI fallback remains available if the host cannot import local modules.
