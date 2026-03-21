---
name: configure
description: Set up the Matrix channel — save the homeserver URL and access token, and review access policy. Use when the user provides Matrix credentials, asks to configure Matrix, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /matrix:configure — Matrix Channel Setup

Writes the homeserver URL and access token to `~/.claude/channels/matrix/.env`
and orients the user on access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Credentials** — check `~/.claude/channels/matrix/.env` for
   `MATRIX_HOMESERVER` and `MATRIX_ACCESS_TOKEN`. Show set/not-set; if token
   is set, show first 10 chars masked (`syt_abc...`).

2. **Access** — read `~/.claude/channels/matrix/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list user IDs
   - Pending pairings: count, with codes and user IDs if any

3. **What next** — end with a concrete next step based on state:
   - No credentials → *"Run `/matrix:configure <homeserver> <token>` with
     your homeserver URL and access token."*
   - Credentials set, policy is pairing, nobody allowed → *"DM your bot on
     Matrix. It replies with a code; approve with `/matrix:access pair
     <code>`."*
   - Credentials set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture Matrix user IDs you don't know. Once the IDs are in, pairing
has done its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes:"* and offer to run
   `/matrix:access policy allowlist`. Do this proactively — don't wait to
   be asked.
4. **If no, people are missing** → *"Have them DM the bot; you'll approve
   each with `/matrix:access pair <code>`. Run this skill again once
   everyone's in and we'll lock it."*
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"DM your bot to capture your own ID first. Then we'll add anyone else
   and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone: *"They'll need to give you their Matrix ID
   (e.g. @user:server.org), or you can briefly flip to pairing:
   `/matrix:access policy pairing` → they DM → you pair → flip back."*

Never frame `pairing` as the correct long-term choice. Don't skip the lockdown
offer.

### `<homeserver> <token>` — save credentials

1. Parse `$ARGUMENTS`: first argument is the homeserver URL, second is the
   access token. The homeserver looks like `https://matrix.example.com`.
   The token looks like `syt_...` or `MDAxY...`.
2. `mkdir -p ~/.claude/channels/matrix`
3. Read existing `.env` if present; update/add `MATRIX_HOMESERVER=` and
   `MATRIX_ACCESS_TOKEN=` lines, preserve other keys. Write back, no quotes
   around values.
4. Confirm, then show the no-args status so the user sees where they stand.

### `clear` — remove credentials

Delete the `MATRIX_HOMESERVER=` and `MATRIX_ACCESS_TOKEN=` lines (or the file
if those are the only lines).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Credential changes need a session
  restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/matrix:access` take effect immediately, no restart.
