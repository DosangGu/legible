import type { ReviewSession } from './model.js'
import type { ChatEventPayload } from './chat.js'
import type { DiffSide } from './diff.js'

export type PreflightTool = 'git' | 'gh' | 'claude' | 'codex'

export type PreflightStatus = 'ready' | 'missing' | 'unauthenticated' | 'error'

export type PreflightCheck = {
  tool: PreflightTool
  status: PreflightStatus
  version?: string
  message?: string
}

export type PreflightReport = {
  status: 'ready' | 'degraded'
  checkedAt: string
  checks: PreflightCheck[]
}

export type DaemonHealth = {
  status: 'ready' | 'degraded'
  version: string
  uptimeSeconds: number
}

export type DaemonSnapshot = {
  preflight: PreflightReport
  sessions: ReviewSession[]
}

export type ApiError = {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

export type ReviewFocusRequest = {
  sessionId: string
  path: string
  line: number
  side: DiffSide
  startLine?: number
}

export type DaemonEvent =
  | { type: 'daemon.snapshot'; payload: DaemonSnapshot }
  | { type: 'preflight.updated'; payload: PreflightReport }
  | { type: 'session.added'; payload: ReviewSession }
  | { type: 'session.updated'; payload: ReviewSession }
  | { type: 'session.removed'; payload: { id: string } }
  | { type: 'chat.event'; payload: ChatEventPayload }
  | { type: 'review.focus.requested'; payload: ReviewFocusRequest }

export type DaemonEventEnvelope = DaemonEvent & {
  sequence: number
  emittedAt: string
}
