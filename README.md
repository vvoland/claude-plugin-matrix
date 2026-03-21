# Claude Code Matrix Plugin

Connect a Matrix bot to your Claude Code session via an MCP server.

This repository is **not** an official Anthropic/Claude plugin. It is maintained at:

- https://github.com/vvoland/claude-plugin-matrix

The MCP server logs into Matrix as a bot account and provides tools to Claude to reply, react, edit messages, and fetch history. When you message the bot, the server forwards the message to your Claude Code session.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.
- The E2EE crypto backend (`@matrix-org/matrix-sdk-crypto-nodejs`) includes native bindings — they install automatically via npm/bun on supported platforms (Linux x64/arm64, macOS x64/arm64).

## Quick Setup

> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for rooms and multi-user setups.

**1. Create a Matrix bot account.**

Register a new account on your homeserver for the bot. You can use any Matrix client (Element, etc.) or the admin API.

You'll need:

- **Homeserver URL** — e.g. `https://matrix.example.com` (the server, not the client URL)
- **Access token** — get one by logging in with the bot account. In Element: Settings → Help & About → scroll to "Access Token". Or use the login API: `curl -X POST https://matrix.example.com/_matrix/client/v3/login -d '{"type":"m.login.password","user":"botuser","password":"..."}'`

**2. Install the plugin.**

From a Claude Code session:

```text
/plugin marketplace add vvoland/claude-plugin-matrix
/plugin install matrix@vvoland
```

Run your claude with the new matrix plugin configured as channel:

```bash
claude --dangerously-load-development-channels plugin:matrix@vvoland
```

**3. Give the server the credentials.**

```text
/matrix:configure https://matrix.example.com syt_your_access_token_here
```

Writes `MATRIX_HOMESERVER=...` and `MATRIX_ACCESS_TOKEN=...` to `~/.claude/channels/matrix/.env`. You can also write that file by hand, or set the variables in your shell environment — shell takes precedence.

**4. Pair.**

With Claude Code running from the previous step, DM your bot on Matrix — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with the channel flag. In your Claude Code session:

```text
/matrix:access pair <code>
```

Your next DM reaches the assistant.

> The bot auto-joins rooms it's invited to. Pairing handles the user-ID lookup so you never need to manually copy Matrix IDs.

**5. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/matrix:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, rooms, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **Matrix user IDs** like `@alice:matrix.org`. Default policy is `pairing`. `ackReaction` accepts any Unicode emoji.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a room. Takes `room_id` + `text`, optionally `reply_to` (event ID) for native threading and `files` (absolute paths) for attachments. Images, video, and audio send with inline preview; other types as file downloads. Max 100MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent event ID(s). |
| `react` | Add an emoji reaction to a message by event ID. **Any Unicode emoji** is accepted. |
| `edit_message` | Edit a message the bot previously sent. Useful for "working..." → result progress updates. Only works on the bot's own messages. |
| `fetch_messages` | Fetch recent messages from a room. Returns up to 100 messages in chronological order. In encrypted rooms, only plaintext events are readable — encrypted events show a placeholder (live messages are decrypted via sync). |
| `download_attachment` | Download media by `mxc://` URL. For encrypted media, pass the `file_info` from the event content to decrypt. Returns the local file path. |

Inbound messages trigger a typing indicator automatically — Matrix shows "botname is typing..." while the assistant works on a response.

## Media

Inbound media (images, files, video, audio) are downloaded to `~/.claude/channels/matrix/inbox/` and the local path is included in the `<channel>` notification so the assistant can `Read` it.

Outbound files are uploaded to the Matrix content repository and sent as proper media events with inline previews where supported.

## End-to-end encryption

E2EE is enabled automatically. The bot uses the Rust crypto SDK (`@matrix-org/matrix-sdk-crypto-nodejs`) for Olm/Megolm key management.

- **Encrypted rooms** — messages are transparently encrypted and decrypted. The SDK handles key exchange, session rotation, and device tracking.
- **Media in E2EE rooms** — files are encrypted with AES-256-CTR before upload and decrypted on download, per the Matrix spec. The decryption key travels inside the encrypted event payload.
- **Crypto state** — persisted in `~/.claude/channels/matrix/crypto/`. **Do not delete this directory** — losing it means the bot gets a new cryptographic identity, old messages become undecryptable, and other users need to re-verify.
- **Plaintext rooms** — still work normally. Encryption is per-room; the bot adapts automatically.

## History

Unlike Telegram, Matrix supports full message history via the `fetch_messages` tool. The assistant can retrieve earlier context from any allowlisted room.
