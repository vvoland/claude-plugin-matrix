# Matrix — Access & Delivery

A Matrix bot can be invited to any room. Without a gate, messages from those rooms would flow straight into your assistant session. The access model described here decides who gets through.

By default, a DM from an unknown sender triggers **pairing**: the bot replies with a 6-character code and drops the message. You run `/matrix:access pair <code>` from your assistant session to approve them. Once approved, their messages pass through.

All state lives in `~/.claude/channels/matrix/access.json`. The `/matrix:access` skill commands edit this file; the server re-reads it on every inbound message, so changes take effect without a restart. Set `MATRIX_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is unavailable in static mode since it requires runtime writes).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Matrix user ID (e.g. `@alice:matrix.org`) |
| Room key | Room ID (e.g. `!abc123:matrix.org`) |
| E2EE | Automatic via Rust crypto SDK |
| `ackReaction` | Any Unicode emoji |
| Config file | `~/.claude/channels/matrix/access.json` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/matrix:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Useful after all users are paired. |
| `disabled` | Drop everything, including allowlisted users and rooms. |

```
/matrix:access policy allowlist
```

## User IDs

Matrix identifies users by **Matrix IDs** like `@alice:matrix.org`. These are permanent and globally unique. The allowlist stores full Matrix IDs.

Pairing captures the ID automatically. To find one manually, the person can check their profile in any Matrix client (Element: click avatar → profile).

```
/matrix:access allow @alice:matrix.org
/matrix:access remove @alice:matrix.org
```

## Rooms

Rooms are off by default. The bot auto-joins when invited, but won't deliver messages until the room is enabled.

```
/matrix:access room add !abc123:matrix.org
```

Room IDs look like `!abc123:matrix.org`. Find them in Element: Room Settings → Advanced → Internal room ID.

With the default `requireMention: true`, the bot responds only when mentioned by display name, user ID, or replied to. Pass `--no-mention` to process every message, or `--allow id1,id2` to restrict which members can trigger it.

```
/matrix:access room add !abc123:matrix.org --no-mention
/matrix:access room add !abc123:matrix.org --allow @alice:matrix.org,@bob:matrix.org
/matrix:access room rm !abc123:matrix.org
```

## Mention detection

In rooms with `requireMention: true`, any of the following triggers the bot:

- The bot's Matrix ID (`@bot:server.org`) appears in the message
- The bot's display name (localpart) appears in the message
- A reply to one of the bot's messages
- A match against any regex in `mentionPatterns`

```
/matrix:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Delivery

Configure outbound behavior with `/matrix:access set <key> <value>`.

**`ackReaction`** reacts to inbound messages on receipt. Matrix accepts any Unicode emoji.

```
/matrix:access set ackReaction 👀
/matrix:access set ackReaction ""
```

**`replyToMode`** controls threading on chunked replies. When a long response is split, `first` (default) threads only the first chunk under the inbound message; `all` threads every chunk; `off` sends all chunks standalone.

**`textChunkLimit`** sets the split threshold. Default is 40000 (practical limit for Matrix clients).

**`chunkMode`** chooses the split strategy: `length` cuts exactly at the limit; `newline` prefers paragraph boundaries.

## Skill reference

| Command | Effect |
| --- | --- |
| `/matrix:access` | Print current state: policy, allowlist, pending pairings, enabled rooms. |
| `/matrix:access pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and sends a confirmation on Matrix. |
| `/matrix:access deny a4f91c` | Discard a pending code. The sender is not notified. |
| `/matrix:access allow @alice:matrix.org` | Add a user ID directly. |
| `/matrix:access remove @alice:matrix.org` | Remove from the allowlist. |
| `/matrix:access policy allowlist` | Set `dmPolicy`. Values: `pairing`, `allowlist`, `disabled`. |
| `/matrix:access room add !abc123:matrix.org` | Enable a room. Flags: `--no-mention`, `--allow @id1,@id2`. |
| `/matrix:access room rm !abc123:matrix.org` | Disable a room. |
| `/matrix:access set ackReaction 👀` | Set a config key: `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`. |

## Config file

`~/.claude/channels/matrix/access.json`. Absent file is equivalent to `pairing` policy with empty lists, so the first DM triggers pairing.

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // Matrix user IDs allowed to DM.
  "allowFrom": ["@alice:matrix.org"],

  // Rooms the bot is active in. Empty object = DM-only.
  "rooms": {
    "!abc123:matrix.org": {
      // true: respond only to @mentions and replies.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = any member (subject to requireMention).
      "allowFrom": []
    }
  },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Emoji reaction on receipt. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Split threshold. Default 40000.
  "textChunkLimit": 40000,

  // length = cut at limit. newline = prefer paragraph boundaries.
  "chunkMode": "newline"
}
```
