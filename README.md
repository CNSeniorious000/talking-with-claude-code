# talking-with-claude-code

One agent skill for inspecting and messaging local Claude Code sessions from Codex, OpenCode, or another coding agent. Uses Bun and Claude's native session registry, transcripts, and Unix inbox sockets.

```sh
bunx skills add CNSeniorious000/talking-with-claude-code
```

See [SKILL.md](SKILL.md). No MCP server, Claude relay process, or runtime dependencies. macOS and Linux; native Windows and cross-machine delivery are not supported.

A send confirms submission only. Add `--wait 60` to open a temporary inbox and await Claude's native `SendMessage` reply. The receiving session's inbound policy still applies.
