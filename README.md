# vvoland Marketplace

This repository is a Claude Code marketplace containing one plugin:

- [matrix](./matrix) — connect a Matrix bot to your Claude Code session via an MCP server.

## matrix

The `matrix` plugin logs into Matrix as a bot account and provides tools to Claude to reply, react, edit messages, and fetch history.

See [matrix/README.md](./matrix/README.md) for setup, access control, media, and encryption details.

### Install

From a Claude Code session:

```text
/plugin marketplace add vvoland/claude-plugin-matrix
/plugin install matrix@vvoland
```

Run your claude with the new matrix plugin configured as channel:

```bash
claude --dangerously-load-development-channels plugin:matrix@vvoland
```

Then configure the included Matrix plugin:

```text
/matrix:configure https://matrix.example.com syt_your_access_token_here
```
