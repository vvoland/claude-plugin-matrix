/**
 * Shared types and constants for the Matrix daemon/MCP client split.
 * Used by both matrix-daemon.ts and server.ts.
 */

import { homedir } from 'os'
import { join } from 'path'

export const STATE_DIR = join(homedir(), '.claude', 'channels', 'matrix')
export const SOCKET_PATH = join(STATE_DIR, 'daemon.sock')
export const PID_FILE = join(STATE_DIR, 'daemon.pid')
export const LOG_FILE = join(STATE_DIR, 'daemon.log')

// Request from MCP to daemon
export type DaemonRequest = {
  id: string
  method: string
  params: Record<string, unknown>
}

// Response from daemon to MCP
export type DaemonResponse = {
  id: string
  result?: unknown
  error?: string
}

// Push from daemon to all connected MCPs (incoming Matrix messages)
export type DaemonPush = {
  method: 'inbound'
  params: {
    content: string
    meta: Record<string, string | undefined>
  }
}
