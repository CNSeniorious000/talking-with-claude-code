# talking-with-claude-code

One agent skill for inspecting and messaging local Claude Code sessions from Codex, OpenCode, or another coding agent. Uses Bun and Claude's native session registry, transcripts, and Unix inbox sockets.

> [!NOTE]
> `SendMessage` is a native Claude Code tool, but we have not found a publicly documented API with compatibility guarantees for external clients connecting to existing sessions. This skill uses a reverse-engineered internal socket protocol, verified with Claude Code 2.1.312; upgrades may change its format or behavior.

```sh
bunx skills add CNSeniorious000/talking-with-claude-code
```

See [SKILL.md](SKILL.md). No MCP server, Claude relay process, or runtime dependencies. macOS and Linux; native Windows and cross-machine delivery are not supported.

A send confirms submission only. Add `--wait 60` to await Claude's native `SendMessage` reply, or `--wait 0` to return immediately. Resume with `wait --request <returned-path> --timeout 60`; timeouts leave the inbox active and late replies are cached. Receivers expire after one hour by default. Use `close --request <path>` to stop receiving and remove cached state. The receiving session's inbound policy still applies.

For ongoing conversations, `open --id <uuid> --pid <pid> --name <display-name>` creates a channel without sending a message. Use `send --channel <path>` repeatedly with one fixed return address, `wait --channel <path> --after <seq>` for the next message, or `follow --channel <path> --after <seq>` for an NDJSON stream. Replies do not close channels; stop them with `close --channel <path>` or let their TTL expire. See the skill for cursor, identity and lifetime semantics.
