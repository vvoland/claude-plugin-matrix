#!/usr/bin/env bun
/**
 * Matrix daemon — standalone process that holds the MatrixClient and E2EE state.
 * Communicates with MCP server instances over a Unix socket using NDJSON.
 *
 * Does NOT import @modelcontextprotocol/sdk.
 */

import * as net from 'net'
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  statSync, renameSync, realpathSync, unlinkSync, existsSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join, extname, sep, basename } from 'path'
import {
  MatrixClient,
  AutojoinRoomsMixin,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
  LogService,
  LogLevel,
} from 'matrix-bot-sdk'
import {
  STATE_DIR, SOCKET_PATH, PID_FILE, LOG_FILE, CRON_FILE,
  type DaemonRequest, type DaemonResponse, type DaemonPush, type CronTask,
} from './protocol.js'

// ---------- Logging ----------
const log = (level: string, msg: string) => process.stderr.write(`[matrix-daemon:${level}] ${msg}\n`)

LogService.setLevel(LogLevel.WARN)
LogService.setLogger({
  info: (mod: string, msg: string) => log('info', `${mod}: ${msg}`),
  warn: (mod: string, msg: string) => log('warn', `${mod}: ${msg}`),
  error: (mod: string, msg: string) => log('error', `${mod}: ${msg}`),
  debug: () => {},
  trace: () => {},
})

// ---------- Paths ----------
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const CRYPTO_DIR = join(STATE_DIR, 'crypto')
const SYNC_FILE = join(STATE_DIR, 'bot-sync.json')
const INBOX_DIR = join(tmpdir(), 'claude-matrix-inbox')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(CRYPTO_DIR, { recursive: true, mode: 0o700 })

// ---------- Load env ----------
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const HOMESERVER = (process.env.MATRIX_HOMESERVER ?? '').replace(/\/+$/, '')
const TOKEN = process.env.MATRIX_ACCESS_TOKEN
const STATIC = process.env.MATRIX_ACCESS_MODE === 'static'

if (!HOMESERVER || !TOKEN) {
  log('error', `MATRIX_HOMESERVER and MATRIX_ACCESS_TOKEN required — set in ${ENV_FILE}`)
  process.exit(1)
}

// ---------- Encrypted media helpers ----------

type EncryptedFileInfo = {
  url: string
  key: { kty: string; key_ops: string[]; alg: string; k: string; ext: boolean }
  iv: string
  hashes: { sha256: string }
  v: string
  mimetype?: string
}

function encryptAttachment(data: Buffer): { ciphertext: Buffer; info: Omit<EncryptedFileInfo, 'url'> } {
  const key = randomBytes(32)
  const iv = Buffer.alloc(16)
  randomBytes(8).copy(iv)
  const cipher = createCipheriv('aes-256-ctr', key, iv)
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])
  const hash = createHash('sha256').update(ciphertext).digest()
  return {
    ciphertext,
    info: {
      v: 'v2',
      key: {
        kty: 'oct',
        key_ops: ['encrypt', 'decrypt'],
        alg: 'A256CTR',
        k: key.toString('base64url'),
        ext: true,
      },
      iv: iv.toString('base64'),
      hashes: { sha256: hash.toString('base64url') },
    },
  }
}

function decryptAttachment(ciphertext: Buffer, info: EncryptedFileInfo): Buffer {
  const key = Buffer.from(info.key.k, 'base64url')
  const iv = Buffer.from(info.iv, 'base64')
  const decipher = createDecipheriv('aes-256-ctr', key, iv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

// ---------- Media upload/download ----------

async function uploadRawMedia(data: Buffer, contentType: string, filename: string): Promise<string> {
  const url = `${HOMESERVER}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': contentType },
    body: data,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`media upload failed: ${res.status} ${text}`)
  }
  const result = await res.json() as { content_uri: string }
  return result.content_uri
}

async function downloadRawMedia(mxcUrl: string): Promise<{ data: Buffer; filename: string }> {
  const m = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/)
  if (!m) throw new Error(`invalid mxc URL: ${mxcUrl}`)
  const [, server, mediaId] = m
  const url = `${HOMESERVER}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  })
  if (!res.ok) throw new Error(`media download failed: ${res.status}`)
  const disposition = res.headers.get('content-disposition') ?? ''
  const fnMatch = disposition.match(/filename="?([^";\s]+)"?/)
  const filename = basename(fnMatch ? fnMatch[1] : mediaId)
  const buf = Buffer.from(await res.arrayBuffer())
  return { data: buf, filename }
}

// ---------- Room encryption cache ----------

const encryptedRoomCache = new Map<string, boolean>()

async function isRoomEncrypted(roomId: string): Promise<boolean> {
  const cached = encryptedRoomCache.get(roomId)
  if (cached === true) return true
  try {
    await client.getRoomStateEvent(roomId, 'm.room.encryption', '')
    encryptedRoomCache.set(roomId, true)
    return true
  } catch {
    encryptedRoomCache.set(roomId, false)
    return false
  }
}

// ---------- MIME / file type helpers ----------

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mov'])
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.opus'])

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json',
  }
  return map[ext] ?? 'application/octet-stream'
}

const MAX_CHUNK_LIMIT = 40000
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

async function uploadFile(
  filePath: string,
  encrypted: boolean,
): Promise<{ content: Record<string, unknown>; msgtype: string }> {
  const ext = extname(filePath).toLowerCase()
  const mime = mimeFromExt(ext)
  const name = basename(filePath)
  const fileData = readFileSync(filePath)
  const size = fileData.length

  let msgtype = 'm.file'
  if (IMAGE_EXTS.has(ext)) msgtype = 'm.image'
  else if (VIDEO_EXTS.has(ext)) msgtype = 'm.video'
  else if (AUDIO_EXTS.has(ext)) msgtype = 'm.audio'

  if (encrypted) {
    const { ciphertext, info } = encryptAttachment(fileData)
    const mxcUri = await uploadRawMedia(ciphertext, 'application/octet-stream', name)
    return {
      msgtype,
      content: {
        msgtype,
        body: name,
        file: { ...info, url: mxcUri, mimetype: mime },
        info: { mimetype: mime, size },
      },
    }
  } else {
    const mxcUri = await uploadRawMedia(fileData, mime, name)
    return {
      msgtype,
      content: {
        msgtype,
        body: name,
        url: mxcUri,
        info: { mimetype: mime, size },
      },
    }
  }
}

type MatrixEvent = {
  type: string
  event_id: string
  sender: string
  room_id: string
  origin_server_ts: number
  content: Record<string, unknown>
}

async function downloadInboundMedia(event: MatrixEvent): Promise<string | undefined> {
  try {
    const fileInfo = event.content?.file as EncryptedFileInfo | undefined
    const directUrl = event.content?.url as string | undefined
    const body = (event.content?.body as string) || 'attachment'

    if (fileInfo?.url) {
      const { data } = await downloadRawMedia(fileInfo.url)
      const decrypted = decryptAttachment(data, fileInfo)
      const ext = extname(body) || '.bin'
      const path = join(INBOX_DIR, `${Date.now()}-${basename(body, ext)}${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, decrypted)
      return path
    } else if (directUrl?.startsWith('mxc://')) {
      const { data, filename } = await downloadRawMedia(directUrl)
      const path = join(INBOX_DIR, `${Date.now()}-${filename}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, data)
      return path
    }
  } catch (err) {
    log('error', `media download failed: ${err}`)
  }
  return undefined
}

// ---------- Access control ----------

type PendingEntry = {
  senderId: string
  roomId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type RoomPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  rooms: Record<string, RoomPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], rooms: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      rooms: parsed.rooms ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    log('warn', 'access.json is corrupt, moved aside. Starting fresh.')
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        log('info', 'static mode — dmPolicy "pairing" downgraded to "allowlist"')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  if (real.startsWith(stateReal + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function assertAllowedRoom(room_id: string): void {
  const access = loadAccess()
  if (room_id in access.rooms) return
  const dmUser = dmRooms.get(room_id)
  if (dmUser && access.allowFrom.includes(dmUser)) return
  throw new Error(`room ${room_id} is not allowlisted — add via /matrix:access`)
}

// DM rooms tracking
const DM_ROOMS_FILE = join(STATE_DIR, 'dm-rooms.json')

const dmRooms: Map<string, string> = (() => {
  try {
    const raw = readFileSync(DM_ROOMS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Map<string, string>()
    return new Map<string, string>(Object.entries(parsed))
  } catch { return new Map<string, string>() }
})()

function saveDmRooms(): void {
  const tmp = DM_ROOMS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(dmRooms)) + '\n', { mode: 0o600 })
  renameSync(tmp, DM_ROOMS_FILE)
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(senderId: string, roomId: string): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }
  if (senderId === botUserId) return { action: 'drop' }

  if (roomId in access.rooms) {
    const policy = access.rooms[roomId]
    const roomAllowFrom = policy.allowFrom ?? []
    if (roomAllowFrom.length > 0 && !roomAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  if (access.allowFrom.includes(senderId)) {
    if (dmRooms.get(roomId) !== senderId) {
      dmRooms.set(roomId, senderId)
      saveDmRooms()
    }
    return { action: 'deliver', access }
  }
  if (access.dmPolicy === 'allowlist') return { action: 'drop' }

  // pairing mode
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      if ((p.replies ?? 1) >= 2) return { action: 'drop' }
      p.replies = (p.replies ?? 1) + 1
      saveAccess(access)
      return { action: 'pair', code, isResend: true }
    }
  }
  if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

  const code = randomBytes(3).toString('hex')
  const now = Date.now()
  access.pending[code] = {
    senderId,
    roomId,
    createdAt: now,
    expiresAt: now + 60 * 60 * 1000,
    replies: 1,
  }
  saveAccess(access)
  return { action: 'pair', code, isResend: false }
}

function isMentioned(body: string, formattedBody: string | undefined, extraPatterns?: string[]): boolean {
  if (body.includes(botUserId)) return true
  const displayName = botUserId.replace(/^@/, '').split(':')[0]
  if (displayName && body.toLowerCase().includes(displayName.toLowerCase())) return true
  if (formattedBody && formattedBody.includes(botUserId)) return true
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(body)) return true
    } catch {}
  }
  return false
}

function isReplyToBot(event: MatrixEvent): boolean {
  const relatesTo = event.content?.['m.relates_to'] as Record<string, unknown> | undefined
  if (relatesTo?.['m.in_reply_to']) {
    const formatted = (event.content?.formatted_body as string) ?? ''
    if (formatted.includes(botUserId)) return true
  }
  return false
}

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch { return }
  if (files.length === 0) return

  for (const safeFilename of files) {
    const file = join(APPROVED_DIR, safeFilename)
    const senderId = decodeURIComponent(safeFilename)
    let roomId: string
    try {
      roomId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!roomId) {
      const access = loadAccess()
      for (const p of Object.values(access.pending)) {
        if (p.senderId === senderId) {
          roomId = p.roomId
          break
        }
      }
    }
    if (roomId) {
      client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: "Paired! Say hi to Claude.",
      }).then(
        () => rmSync(file, { force: true }),
        err => {
          log('error', `failed to send approval confirm: ${err}`)
          rmSync(file, { force: true })
        },
      )
    } else {
      rmSync(file, { force: true })
    }
  }
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ---------- Matrix client (uses `let` for OTK recovery) ----------

const storage = new SimpleFsStorageProvider(SYNC_FILE)
const cryptoProvider = new RustSdkCryptoStorageProvider(CRYPTO_DIR)
let client = new MatrixClient(HOMESERVER, TOKEN, storage, cryptoProvider)
AutojoinRoomsMixin.setupOnClient(client)

let botUserId = ''

// ---------- Permission request tracking ----------

const pendingPermissions = new Map<string, {
  tool_name: string
  description: string
  input_preview: string
  eventIds: Map<string, string> // eventId → request_id (for reaction-based replies)
}>()

// Reverse lookup: event_id → request_id for reaction handling
const permissionEventMap = new Map<string, string>()

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------- Connected MCP clients ----------

const connectedClients = new Set<net.Socket>()

function broadcast(push: DaemonPush): void {
  const line = JSON.stringify(push) + '\n'
  for (const sock of connectedClients) {
    try {
      sock.write(line)
    } catch {
      connectedClients.delete(sock)
    }
  }
}

// ---------- Inbound handler ----------

async function handleInbound(event: MatrixEvent, roomId: string): Promise<void> {
  const senderId = event.sender
  const body = (event.content?.body as string) ?? ''
  const formattedBody = event.content?.formatted_body as string | undefined
  const msgtype = event.content?.msgtype as string

  const access = loadAccess()
  if (roomId in access.rooms) {
    const policy = access.rooms[roomId]
    if (policy.requireMention ?? true) {
      if (!isMentioned(body, formattedBody, access.mentionPatterns) && !isReplyToBot(event)) {
        return
      }
    }
  }

  const result = gate(senderId, roomId)
  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: `${lead} — run in Claude Code:\n\n/matrix:access pair ${result.code}`,
    })
    return
  }

  // Intercept text-based permission replies (e.g. "y abcde" or "no abcde")
  const permMatch = PERMISSION_REPLY_RE.exec(body)
  if (permMatch) {
    const request_id = permMatch[2]!.toLowerCase()
    if (pendingPermissions.has(request_id)) {
      const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny' as const
      const perm = pendingPermissions.get(request_id)!
      // Clean up event mappings
      for (const evId of perm.eventIds.keys()) permissionEventMap.delete(evId)
      pendingPermissions.delete(request_id)
      broadcast({ method: 'permission_response', params: { request_id, behavior } })
      // React with result emoji
      const emoji = behavior === 'allow' ? '\u2705' : '\u274c'
      void client.sendEvent(roomId, 'm.reaction', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: event.event_id, key: emoji },
      }).catch(() => {})
      return
    }
  }

  // Typing indicator
  void client.setTyping(roomId, true, 10000).catch(() => {})

  // Ack reaction
  if (result.access.ackReaction && event.event_id) {
    void client.sendEvent(roomId, 'm.reaction', {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: event.event_id,
        key: result.access.ackReaction,
      },
    }).catch(() => {})
  }

  // Download media if present
  let imagePath: string | undefined
  if (msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.video' || msgtype === 'm.audio') {
    imagePath = await downloadInboundMedia(event)
  }

  const text = msgtype === 'm.image' ? (body || '(image)')
    : msgtype === 'm.file' ? (body || '(file)')
    : msgtype === 'm.video' ? (body || '(video)')
    : msgtype === 'm.audio' ? (body || '(audio)')
    : body

  // Broadcast to all connected MCP clients
  broadcast({
    method: 'inbound',
    params: {
      content: text,
      meta: {
        room_id: roomId,
        event_id: event.event_id,
        user: senderId,
        user_id: senderId,
        ts: new Date(event.origin_server_ts).toISOString(),
        ...(imagePath ? { image_path: imagePath } : {}),
      },
    },
  })

  // Stop typing
  void client.setTyping(roomId, false).catch(() => {})
}

// ---------- Tool request handler ----------

async function handleToolRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'reply': {
      const room_id = params.room_id as string
      const text = params.text as string
      const reply_to = params.reply_to as string | undefined
      const files = (params.files as string[] | undefined) ?? []

      assertAllowedRoom(room_id)

      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 100MB)`)
        }
      }

      const access = loadAccess()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const mode = access.chunkMode ?? 'length'
      const replyMode = access.replyToMode ?? 'first'
      const chunks = chunk(text, limit, mode)
      const sentIds: string[] = []

      try {
        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo =
            reply_to != null &&
            replyMode !== 'off' &&
            (replyMode === 'all' || i === 0)
          const content: Record<string, unknown> = {
            msgtype: 'm.text',
            body: chunks[i],
          }
          if (shouldReplyTo) {
            content['m.relates_to'] = {
              'm.in_reply_to': { event_id: reply_to },
            }
          }
          const eventId = await client.sendMessage(room_id, content)
          sentIds.push(eventId)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(
          `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`,
        )
      }

      const roomEncrypted = files.length > 0 ? await isRoomEncrypted(room_id) : false
      for (const f of files) {
        const { content } = await uploadFile(f, roomEncrypted)
        if (reply_to && replyMode !== 'off') {
          content['m.relates_to'] = {
            'm.in_reply_to': { event_id: reply_to },
          }
        }
        const eventId = await client.sendMessage(room_id, content)
        sentIds.push(eventId)
      }

      return sentIds.length === 1
        ? `sent (id: ${sentIds[0]})`
        : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
    }

    case 'react': {
      assertAllowedRoom(params.room_id as string)
      const eventId = await client.sendEvent(params.room_id as string, 'm.reaction', {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: params.event_id as string,
          key: params.emoji as string,
        },
      })
      return `reacted (id: ${eventId})`
    }

    case 'edit_message': {
      assertAllowedRoom(params.room_id as string)
      const newText = params.text as string
      const eventId = await client.sendEvent(params.room_id as string, 'm.room.message', {
        msgtype: 'm.text',
        body: `* ${newText}`,
        'm.new_content': {
          msgtype: 'm.text',
          body: newText,
        },
        'm.relates_to': {
          rel_type: 'm.replace',
          event_id: params.event_id as string,
        },
      })
      return `edited (id: ${eventId})`
    }

    case 'fetch_messages': {
      assertAllowedRoom(params.room_id as string)
      const limit = Math.max(1, Math.min(Number(params.limit) || 20, 100))
      const roomId = params.room_id as string
      const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`
      const result = await client.doRequest('GET', path) as { chunk: MatrixEvent[] }
      const rawEvents = (result.chunk ?? []).reverse()

      const messages = rawEvents.map(ev => {
        if (ev.type === 'm.room.encrypted') {
          return {
            type: ev.type,
            event_id: ev.event_id,
            sender: ev.sender,
            origin_server_ts: ev.origin_server_ts,
            note: 'encrypted event — content not available via history fetch',
          }
        }
        return {
          type: ev.type,
          event_id: ev.event_id,
          sender: ev.sender,
          origin_server_ts: ev.origin_server_ts,
          content: ev.content,
        }
      })
      return JSON.stringify(messages, null, 2)
    }

    case 'typing': {
      assertAllowedRoom(params.room_id as string)
      const isTyping = params.typing as boolean
      const timeout = (params.timeout as number | undefined) ?? 30000
      await client.setTyping(params.room_id as string, isTyping, isTyping ? timeout : undefined)
      return isTyping ? 'typing indicator started' : 'typing indicator stopped'
    }

    case 'download_attachment': {
      const mxcUrl = params.mxc_url as string
      const fileInfo = params.file_info as EncryptedFileInfo | undefined

      const { data, filename } = await downloadRawMedia(mxcUrl)
      let finalData = data

      if (fileInfo?.key && fileInfo?.iv) {
        finalData = decryptAttachment(data, fileInfo)
      }

      const outPath = join(INBOX_DIR, `${Date.now()}-${filename}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(outPath, finalData)
      return `downloaded to ${outPath}`
    }

    case 'cron_create': {
      const name = params.name as string
      const schedule = params.schedule as string
      const prompt = params.prompt as string
      if (!name || !schedule || !prompt) throw new Error('name, schedule, and prompt are required')

      // Validate cron expression (must be 5 fields)
      if (schedule.trim().split(/\s+/).length !== 5) {
        throw new Error('schedule must be a 5-field cron expression: minute hour dom month dow')
      }

      const tasks = loadCronTasks()

      // Check for duplicate name
      const existing = tasks.find(t => t.name === name)
      if (existing) {
        // Update existing task
        existing.schedule = schedule
        existing.prompt = prompt
        existing.enabled = true
        saveCronTasks(tasks)
        return `updated task "${name}" (id: ${existing.id})`
      }

      const task: CronTask = {
        id: randomBytes(4).toString('hex'),
        name,
        schedule,
        prompt,
        enabled: true,
        createdAt: new Date().toISOString(),
      }
      tasks.push(task)
      saveCronTasks(tasks)
      return `created task "${name}" (id: ${task.id}, schedule: ${schedule})`
    }

    case 'cron_delete': {
      const id = params.id as string | undefined
      const name = params.name as string | undefined
      if (!id && !name) throw new Error('id or name is required')

      const tasks = loadCronTasks()
      const idx = tasks.findIndex(t => t.id === id || t.name === name)
      if (idx === -1) throw new Error(`task not found: ${id || name}`)

      const removed = tasks.splice(idx, 1)[0]
      saveCronTasks(tasks)
      return `deleted task "${removed.name}" (id: ${removed.id})`
    }

    case 'cron_list': {
      const tasks = loadCronTasks()
      if (tasks.length === 0) return 'no scheduled tasks'
      return JSON.stringify(tasks, null, 2)
    }

    case 'cron_toggle': {
      const id = params.id as string | undefined
      const name = params.name as string | undefined
      const enabled = params.enabled as boolean
      if (!id && !name) throw new Error('id or name is required')

      const tasks = loadCronTasks()
      const task = tasks.find(t => t.id === id || t.name === name)
      if (!task) throw new Error(`task not found: ${id || name}`)

      task.enabled = enabled
      saveCronTasks(tasks)
      return `task "${task.name}" is now ${enabled ? 'enabled' : 'disabled'}`
    }

    case 'permission_request': {
      const { request_id, tool_name, description, input_preview } = params as {
        request_id: string; tool_name: string; description: string; input_preview: string
      }
      if (!request_id || !tool_name) throw new Error('request_id and tool_name are required')

      let prettyInput: string
      try {
        prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
      } catch {
        prettyInput = input_preview
      }

      const text =
        `\ud83d\udd10 Permission: ${tool_name}\n\n` +
        `tool_name: ${tool_name}\n` +
        `description: ${description}\n` +
        `input_preview:\n${prettyInput}\n\n` +
        `Reply "\u2705 Allow" or "\u274c Deny" as a reaction, or type "y ${request_id}" / "n ${request_id}"`

      const perm = {
        tool_name,
        description,
        input_preview,
        eventIds: new Map<string, string>(),
      }
      pendingPermissions.set(request_id, perm)

      // Send to DM rooms of allowlisted users
      const access = loadAccess()
      let sent = 0
      for (const userId of access.allowFrom) {
        // Find DM room for this user
        for (const [roomId, dmUser] of dmRooms.entries()) {
          if (dmUser === userId) {
            try {
              const eventId = await client.sendMessage(roomId, {
                msgtype: 'm.text',
                body: text,
              })
              perm.eventIds.set(eventId, request_id)
              permissionEventMap.set(eventId, request_id)
              sent++
            } catch (err) {
              log('warn', `permission_request send to ${userId} failed: ${err}`)
            }
            break
          }
        }
      }

      return `permission request sent to ${sent} user(s)`
    }

    default:
      throw new Error(`unknown method: ${method}`)
  }
}

// ---------- Socket client handler ----------

function handleClient(sock: net.Socket): void {
  connectedClients.add(sock)
  let buffer = ''

  sock.on('data', (data: Buffer) => {
    buffer += data.toString()
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      if (!line) continue

      let request: DaemonRequest
      try {
        request = JSON.parse(line) as DaemonRequest
      } catch {
        log('warn', `invalid JSON from client: ${line.slice(0, 200)}`)
        continue
      }

      handleToolRequest(request.method, request.params).then(
        result => {
          const response: DaemonResponse = { id: request.id, result }
          sock.write(JSON.stringify(response) + '\n')
        },
        err => {
          const response: DaemonResponse = {
            id: request.id,
            error: err instanceof Error ? err.message : String(err),
          }
          sock.write(JSON.stringify(response) + '\n')
        },
      )
    }
  })

  sock.on('close', () => {
    connectedClients.delete(sock)
  })

  sock.on('error', (err) => {
    log('warn', `client socket error: ${err.message}`)
    connectedClients.delete(sock)
  })
}

// ---------- PID file management ----------

function writePidFile(): void {
  writeFileSync(PID_FILE, String(process.pid) + '\n')
}

function cleanupPidFile(): void {
  try {
    const pid = readFileSync(PID_FILE, 'utf8').trim()
    if (pid === String(process.pid)) {
      unlinkSync(PID_FILE)
    }
  } catch {}
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------- Start Unix socket server ----------

async function startSocketServer(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(handleClient)

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Check if existing daemon is alive
        try {
          const existingPid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
          if (existingPid && isProcessAlive(existingPid)) {
            reject(new Error(`daemon already running (pid ${existingPid})`))
            return
          }
        } catch {}

        // Stale socket — remove and retry
        log('info', 'removing stale socket')
        try { unlinkSync(SOCKET_PATH) } catch {}
        server.listen(SOCKET_PATH, () => resolve(server))
      } else {
        reject(err)
      }
    })

    server.listen(SOCKET_PATH, () => resolve(server))
  })
}

// ---------- Start Matrix client ----------

function setupMatrixHandlers(c: MatrixClient): void {
  c.on('room.message', async (roomId: string, event: MatrixEvent) => {
    if (!event?.sender || event.sender === botUserId) return
    if (event.type !== 'm.room.message') return
    if ((event.content?.['m.relates_to'] as Record<string, unknown> | undefined)?.rel_type === 'm.replace') return
    await handleInbound(event, roomId)
  })

  // Handle reactions (👍 = approval/confirmation)
  c.on('room.event', async (roomId: string, event: MatrixEvent) => {
    if (!event?.sender || event.sender === botUserId) return
    if (event.type !== 'm.reaction') return

    const relatesTo = event.content?.['m.relates_to'] as Record<string, unknown> | undefined
    if (!relatesTo || relatesTo.rel_type !== 'm.annotation') return

    const emoji = relatesTo.key as string
    const targetEventId = relatesTo.event_id as string

    // Check if this is a reaction to a permission request message
    const permRequestId = permissionEventMap.get(targetEventId)
    if (permRequestId && (emoji === '\u2705' || emoji === '\u274c')) {
      const access = loadAccess()
      if (access.allowFrom.includes(event.sender)) {
        const behavior = emoji === '\u2705' ? 'allow' : 'deny' as const
        const perm = pendingPermissions.get(permRequestId)
        if (perm) {
          for (const evId of perm.eventIds.keys()) permissionEventMap.delete(evId)
          pendingPermissions.delete(permRequestId)
          broadcast({ method: 'permission_response', params: { request_id: permRequestId, behavior } })
          // Edit the permission message to show result
          const label = behavior === 'allow' ? '\u2705 Allowed' : '\u274c Denied'
          void client.sendEvent(roomId, 'm.room.message', {
            msgtype: 'm.text',
            body: `* ${label}`,
            'm.new_content': { msgtype: 'm.text', body: label },
            'm.relates_to': { rel_type: 'm.replace', event_id: targetEventId },
          }).catch(() => {})
        }
        return
      }
    }

    // Forward reaction as inbound notification
    const text = `[reaction: ${emoji} on ${targetEventId}]`
    const meta: Record<string, string | undefined> = {
      room_id: roomId,
      event_id: event.event_id,
      user: event.sender,
      user_id: event.sender,
      ts: new Date(event.origin_server_ts).toISOString(),
      reaction_emoji: emoji,
      reaction_target: targetEventId,
    }
    broadcast({ method: 'inbound', params: { content: text, meta } })
  })

  c.on('room.failed_decryption', (_roomId: string, _event: unknown, err: Error) => {
    log('warn', `decryption failed: ${err.message}`)
  })
}

// ---------- Cron scheduler ----------

function loadCronTasks(): CronTask[] {
  try {
    const raw = readFileSync(CRON_FILE, 'utf8')
    return JSON.parse(raw) as CronTask[]
  } catch {
    return []
  }
}

function saveCronTasks(tasks: CronTask[]): void {
  const tmp = CRON_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(tasks, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, CRON_FILE)
}

/**
 * Parse a cron expression field against a value.
 * Supports: *, exact numbers, comma-separated lists, ranges (1-5), steps (star/N).
 */
function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    // step: */N or range/N
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/')
      const step = parseInt(stepStr, 10)
      if (isNaN(step) || step <= 0) continue
      if (range === '*') {
        if (value % step === 0) return true
      } else if (range.includes('-')) {
        const [lo, hi] = range.split('-').map(Number)
        if (value >= lo && value <= hi && (value - lo) % step === 0) return true
      }
      continue
    }
    // range: N-M
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number)
      if (value >= lo && value <= hi) return true
      continue
    }
    // exact
    if (parseInt(part, 10) === value) return true
  }
  return false
}

function cronMatches(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [minute, hour, dom, month, dow] = parts
  return (
    cronFieldMatches(minute, date.getMinutes()) &&
    cronFieldMatches(hour, date.getHours()) &&
    cronFieldMatches(dom, date.getDate()) &&
    cronFieldMatches(month, date.getMonth() + 1) &&
    cronFieldMatches(dow, date.getDay())
  )
}

/**
 * Find the next minute in (after, before] that matches the cron schedule.
 * Returns null if no occurrence exists in that window.
 * Caps the search at 48 hours to avoid runaway iteration.
 */
function nextCronOccurrence(schedule: string, after: Date, before: Date): Date | null {
  const candidate = new Date(after)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  // Cap search window at 48 hours
  const maxSearch = new Date(after.getTime() + 48 * 60 * 60_000)
  const limit = before < maxSearch ? before : maxSearch

  while (candidate <= limit) {
    if (cronMatches(schedule, candidate)) return candidate
    candidate.setMinutes(candidate.getMinutes() + 1)
  }
  return null
}

function checkCronTasks(): void {
  if (connectedClients.size === 0) return // nobody listening

  const now = new Date()
  const tasks = loadCronTasks()
  let changed = false

  for (const task of tasks) {
    if (!task.enabled) continue

    const anchor = task.lastRunAt ?? task.createdAt
    const after = new Date(anchor)
    const next = nextCronOccurrence(task.schedule, after, now)

    if (next) {
      task.lastRunAt = now.toISOString()
      changed = true
      log('info', `cron firing: ${task.name} (${task.id})`)

      broadcast({
        method: 'inbound',
        params: {
          content: task.prompt,
          meta: {
            source: 'cron',
            task_id: task.id,
            task_name: task.name,
            schedule: task.schedule,
            ts: now.toISOString(),
          },
        },
      })
    }
  }

  if (changed) saveCronTasks(tasks)
}

// ---------- Main ----------

async function main(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

  const socketServer = await startSocketServer()
  writePidFile()
  log('info', `daemon started (pid ${process.pid}), socket at ${SOCKET_PATH}`)

  // Graceful shutdown
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    log('info', 'shutting down...')

    // Close all client sockets
    for (const sock of connectedClients) {
      try { sock.destroy() } catch {}
    }
    connectedClients.clear()

    // Close socket server
    socketServer.close()
    try { unlinkSync(SOCKET_PATH) } catch {}

    // Stop Matrix client
    try { await client.stop() } catch {}

    // Cleanup
    cleanupPidFile()
    log('info', 'shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Login
  try {
    botUserId = await client.getUserId()
    log('info', `logged in as ${botUserId}`)
  } catch (err) {
    log('error', `login failed: ${err}`)
    cleanupPidFile()
    try { unlinkSync(SOCKET_PATH) } catch {}
    process.exit(1)
  }

  // Register event handlers
  setupMatrixHandlers(client)

  // Start sync with OTK recovery
  try {
    await client.start()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('already exists') && msg.includes('one_time_key')) {
      log('warn', 'OTK conflict detected, resetting crypto state and retrying...')
      await client.stop()
      for (const f of readdirSync(CRYPTO_DIR)) {
        rmSync(join(CRYPTO_DIR, f), { force: true })
      }
      const freshCrypto = new RustSdkCryptoStorageProvider(CRYPTO_DIR)
      const freshStorage = new SimpleFsStorageProvider(SYNC_FILE)
      // Fix: reassign `client` so tool handlers use the fresh instance
      client = new MatrixClient(HOMESERVER, TOKEN, freshStorage, freshCrypto)
      AutojoinRoomsMixin.setupOnClient(client)
      setupMatrixHandlers(client)
      await client.start()
      log('info', 'listening for messages (E2EE enabled, crypto reset)')
    } else {
      throw err
    }
  }
  log('info', 'listening for messages (E2EE enabled)')

  // Start approval checker
  if (!STATIC) setInterval(checkApprovals, 5000)

  // Start cron scheduler — check every 15 seconds
  setInterval(checkCronTasks, 15_000)
  log('info', `cron scheduler started (${loadCronTasks().filter(t => t.enabled).length} active tasks)`)
}

main().catch(err => {
  log('error', `fatal: ${err}`)
  cleanupPidFile()
  try { unlinkSync(SOCKET_PATH) } catch {}
  process.exit(1)
})
