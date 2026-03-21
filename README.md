# Claude Code Matrix Plugin

Connect a Matrix bot to your Claude Code session via an MCP server.

## Install

This plugin is installed via a Claude Code marketplace catalog.

```text
/plugin marketplace add vvoland/claude-marketplace
/plugin install matrix@vvoland
```

Then run Claude Code with the Matrix channel enabled:

```bash
claude --dangerously-load-development-channels plugin:matrix@vvoland
```

Then configure the plugin:

```text
/matrix:configure https://matrix.example.com syt_your_access_token_here
```

## Documentation

See [matrix/README.md](./matrix/README.md) for setup, access control, media, and encryption details.
