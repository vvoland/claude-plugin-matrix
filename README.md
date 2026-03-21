# Claude Code Matrix Plugin

Connect a Matrix bot to your Claude Code session via an MCP server.

This repository is the source for the **Matrix plugin** and includes a single-plugin Claude Code marketplace entry used for installation.

## Install

From a Claude Code session:

```text
/plugin marketplace add vvoland/claude-plugin-matrix
/plugin install matrix@vvoland
```

Run Claude Code with the Matrix channel enabled:

```bash
claude --dangerously-load-development-channels plugin:matrix@vvoland
```

Then configure the plugin:

```text
/matrix:configure https://matrix.example.com syt_your_access_token_here
```

## Documentation

See [matrix/README.md](./matrix/README.md) for setup, access control, media, and encryption details.
