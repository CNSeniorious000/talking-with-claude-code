# talking-with-claude-code

A local messaging bridge that lets Codex, OpenCode, or another coding agent find and talk to your Claude Code sessions.

Claude Code already keeps a local registry of its sessions, including their messaging addresses. This skill uses that registry to discover sessions, read their conversation context, and contact the right one. Claude does not have to send the first message, and you do not need to copy a session's address by hand.

Your agent can ask Claude a question, request a review, or keep an ongoing conversation open. A channel gives it a return address that Claude receives with the first message. Messaging is full-duplex: both sides can send multiple messages independently, without waiting for their turn, while that channel remains open. Claude sends through its native `SendMessage` tool.

Claude can send back only after your agent has shared its return address. This skill does not add the external agent to Claude's session list. Incoming messages are saved until your agent reads them; they do not automatically wake an agent that has stopped running.

## Install

```sh
bunx skills add CNSeniorious000/talking-with-claude-code
```

Requires Bun on macOS or Linux, with Claude Code sessions running under the same OS user. No MCP server or extra Claude process is needed; a lightweight Bun receiver handles return messages. Native Windows and cross-machine delivery are not supported.

## Use

Ask your agent, for example:

- “Show me the active Claude Code sessions and what each is working on.”
- “Ask the Claude session reviewing this project what it found.”
- “Keep a conversation open with that session and wait for its updates.”

Your agent follows [SKILL.md](SKILL.md) to identify the recipient and manage the conversation. Channels stay open for one hour by default, and a wait timeout does not close them.

Agents with a persistent Bun MCP or CodeAct runtime can import the communication library directly, keep conversation state between tool calls, and compose multi-round exchanges in code.

## Compatibility

The receiving session can hold or refuse messages according to its permission settings. Successful submission does not prove that Claude has read the message or completed the requested work.

> [!NOTE]
> `SendMessage` is a native Claude Code tool, but the external socket protocol is an internal implementation detail, not a public API with compatibility guarantees. This skill was verified with Claude Code 2.1.312; upgrades may change its format or behavior.
