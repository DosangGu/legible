import { randomUUID } from 'node:crypto'
import { chmod, open, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ReviewSession } from '@legible/protocol'

import type { PersistedChatState } from '../chats/service.js'

export type PersistedSessionRecord = {
  version: 2
  session: ReviewSession
  chat?: PersistedChatState
}

export class SessionStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionStoreError'
  }
}

export class SessionStore {
  readonly #directory: string

  constructor(stateDirectory = defaultStateDirectory()) {
    this.#directory = join(resolve(stateDirectory), 'sessions')
  }

  async loadAll(): Promise<PersistedSessionRecord[]> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    await chmod(this.#directory, 0o700)
    const names = (await readdir(this.#directory)).filter((name) => name.endsWith('.json')).sort()
    const records: PersistedSessionRecord[] = []
    for (const name of names) {
      const path = join(this.#directory, name)
      try {
        records.push(validateRecord(JSON.parse(await readFile(path, 'utf8')), path))
      } catch (error) {
        if (error instanceof SessionStoreError) throw error
        throw new SessionStoreError(`Unable to load session file: ${path}`, { cause: error })
      }
    }
    return records
  }

  async save(record: PersistedSessionRecord): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    await chmod(this.#directory, 0o700)
    const target = this.#path(record.session.id)
    const temporary = join(this.#directory, `.${safeId(record.session.id)}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      await rename(temporary, target)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async remove(sessionId: string): Promise<void> {
    await unlink(this.#path(sessionId)).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    })
  }

  pathFor(sessionId: string): string {
    return this.#path(sessionId)
  }

  #path(sessionId: string): string {
    return join(this.#directory, `${safeId(sessionId)}.json`)
  }
}

function validateRecord(value: unknown, path: string): PersistedSessionRecord {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !isReviewSession(value.session) ||
    (value.chat !== undefined && !isPersistedChat(value.chat))
  ) {
    throw new SessionStoreError(`Invalid or unsupported session file: ${path}`)
  }
  safeId(value.session.id)
  return { ...(value as PersistedSessionRecord), version: 2 }
}

function isReviewSession(value: unknown): value is ReviewSession {
  if (
    !isRecord(value) ||
    !Array.isArray(value.comments) ||
    !value.comments.every(isDraftComment) ||
    !isRecord(value.config) ||
    !isAgentSpec(value.config.main)
  )
    return false
  return (
    typeof value.id === 'string' &&
    typeof value.repoId === 'string' &&
    typeof value.prNumber === 'number' &&
    typeof value.headSha === 'string' &&
    typeof value.baseSha === 'string' &&
    typeof value.worktreePath === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.submission === undefined || isReviewSubmission(value.submission))
  )
}

function isReviewSubmission(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (value.status !== 'submitting' &&
      value.status !== 'uncertain' &&
      value.status !== 'submitted') ||
    (value.event !== 'COMMENT' && value.event !== 'REQUEST_CHANGES' && value.event !== 'APPROVE') ||
    typeof value.marker !== 'string' ||
    typeof value.startedAt !== 'string' ||
    typeof value.currentHeadSha !== 'string' ||
    typeof value.staleHead !== 'boolean' ||
    (value.body !== undefined && typeof value.body !== 'string')
  )
    return false
  if (value.status !== 'submitted') return true
  return (
    typeof value.githubReviewId === 'number' &&
    typeof value.htmlUrl === 'string' &&
    typeof value.submittedAt === 'string' &&
    isRecord(value.cleanup) &&
    (value.cleanup.status === 'pending' ||
      value.cleanup.status === 'complete' ||
      value.cleanup.status === 'failed') &&
    (value.cleanup.message === undefined || typeof value.cleanup.message === 'string')
  )
}

function isDraftComment(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.path === 'string' &&
    typeof value.line === 'number' &&
    (value.side === 'LEFT' || value.side === 'RIGHT') &&
    typeof value.body === 'string' &&
    (value.origin === 'human' || value.origin === 'codex' || value.origin === 'claude') &&
    typeof value.createdAt === 'string'
  )
}

function isAgentSpec(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.backend === 'codex' || value.backend === 'claude') &&
    (value.shell === 'none' || value.shell === 'git' || value.shell === 'broad') &&
    (value.network === 'off' || value.network === 'fetch' || value.network === 'free') &&
    (value.onOutOfScope === 'deny' || value.onOutOfScope === 'ask')
  )
}

function isPersistedChat(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.snapshot)) return false
  const snapshot = value.snapshot
  return (
    typeof snapshot.sessionId === 'string' &&
    typeof snapshot.revision === 'number' &&
    typeof snapshot.status === 'string' &&
    snapshot.backend === 'codex' &&
    Array.isArray(snapshot.entries) &&
    snapshot.entries.every(
      (entry) => isRecord(entry) && typeof entry.id === 'string' && typeof entry.kind === 'string',
    )
  )
}

function safeId(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) throw new SessionStoreError('Invalid session id')
  return sessionId
}

function defaultStateDirectory(): string {
  const xdg = process.env.XDG_STATE_HOME
  return xdg ? resolve(xdg, 'legible') : resolve(homedir(), '.local', 'state', 'legible')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error
}
