# Direct Bun API

Use `await import("<skill-dir>/scripts/sessions.mjs")` in Bun MCP. Import performs no session access, output or CLI execution. Adjacent `sessions.d.mts` supplies TypeScript types; Bun itself only transpiles, so runtime validation still applies.

```js
var { createSessions } = await import("<skill-dir>/scripts/sessions.mjs");
var sessions = createSessions(); // optional { configDir: "/absolute/claude-config" }
var listed = await sessions.list({ noPreview: true });
```

Pin the intended recipient's exact `id` and `pid` from a fresh list, then:

```js
var channel = await sessions.connect({ id, pid, name: "OpenCode · review" });
await channel.send({ text: "Report the review progress." });
var answer = await channel.wait({ timeout: 20 });
console.log(answer, channel.snapshot());
```

Retain the channel object across Bun calls. It owns the recipient and advances its cursor after each successful wait. `senderMode`, when known, belongs only on `connect`, never `channel.send`. Sender permissions and target identity checks are unchanged.

| Method / field | Meaning |
| --- | --- |
| `channel.send({ text, messageId? })` | Submit once; returns an outgoing `messageId`, never an incoming `seq`. Same-ID retries retain the existing delivery attempt. |
| `channel.wait({ timeout?, until? })` | Defaults to `until: "reply"`; collects intermediate receipts. `"event"` returns one receipt or reply. Timeout advances past any receipts and preserves the channel. |
| `channel.status({ messageId })` | Query an outgoing submission. |
| `channel.close()` | Close and release cached state; repeated close on this object is safe. `closed` becomes true only after a successful close. |
| `channel.handle` | Private `request.json` file handle for recovery, not a message address. |
| `channel.address` | Actual `uds:` reply address. |
| `channel.cursor` | Read-only incoming event cursor; no manual `after` on the bound object's wait. |
| `channel.snapshot()` / `JSON.stringify(channel)` | Serializable handle, address, cursor, recipient metadata and local closed state. No methods. |

Save the snapshot when state changes. To continue after context loss, call `sessions.resumeChannel(savedSnapshot)`; it reads metadata from the existing handle and restores only the supplied cursor. It does not open a new inbox, resend, or trust the snapshot's address/recipient fields. Close or expiry may make recovery unavailable; cached replies remain readable after expiry. Use one cursor owner: stop using the old object after handing its checkpoint to another.

Inspect `answer.reply` and `answer.receipts` using SKILL.md's rules. Timeouts and terminal receipts return as data without changing the host exit code; transport/argument failures throw errors with `code` and any recovery handle. A correlated terminal receipt ends that message, not the channel; report the reason rather than waiting again for its answer.

For multiple replies, call `channel.wait()` repeatedly. Independent channels can use `Promise.all`. Sending can overlap a wait; two waits on one object fail with `wait_in_progress` instead of silently reading the same event. Replies are not automatically correlated to individual sends. Do not retry with a fresh message ID merely because a wait timed out.

Keep each library wait shorter than the Bun MCP tool timeout: a tool timeout may destroy its context and receiver. Reuse only the Bun session ID returned by the MCP. Close channels before resetting/deleting that context. For a conversation contained in one call, use `try/finally`; across calls, retain the channel until the conversation ends.

## Compatibility

Existing `sessions.open/send/wait/status/channels/close` methods retain their CLI-shaped result objects and explicit string handles/cursors. `list/read` are shared by both styles. CamelCase options are `noPreview`, `maxChars`, `senderMode`, `messageId`, `replyTtl`; numeric values can be numbers. Direct `send({text: "-"})` sends a literal dash, never reads stdin.

`createSessions` is the public composition interface. Other module exports are internal; do not replace validation callbacks or construct raw socket frames to work around an API failure. Use the CLI when the host cannot import local modules.
