import type { ReviewSession } from '@legible/protocol'

import type { EventBus } from '../events/event-bus.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ServiceError } from '../common/service-error.js'

export class DuplicateSessionError extends Error {
  constructor(id: string) {
    super(`Session already exists: ${id}`)
    this.name = 'DuplicateSessionError'
  }
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`)
    this.name = 'SessionNotFoundError'
  }
}

export class SessionRegistry {
  readonly #context = new AsyncLocalStorage<{ id: string; revision: number }>()
  readonly #refreshing = new Set<string>()

  withRevision<T>(id: string, revision: number, action: () => T): T {
    return this.#context.run({ id, revision }, action)
  }

  assertMutable(id: string): void {
    this.assertCurrent(id)
    if (this.get(id)?.deletionRequestedAt)
      throw new ServiceError('review_deleting', 'This review is pending deletion', 409)
    if (this.get(id)?.archivedAt)
      throw new ServiceError(
        'review_archived',
        'Restore this archived review before continuing',
        409,
      )
  }

  assertCurrent(id: string): void {
    if (this.#refreshing.has(id))
      throw new ServiceError(
        'review_refreshing',
        'Review is being updated; retry after it finishes',
        409,
      )
    const context = this.#context.getStore()
    if (context?.id === id && context.revision !== (this.get(id)?.reviewRevision ?? 0))
      throw new ServiceError(
        'stale_review_revision',
        'Review changed. Reload before making changes.',
        409,
      )
  }

  beginRefresh(id: string): () => void {
    this.assertMutable(id)
    return this.beginUpdate(id)
  }

  beginUpdate(id: string): () => void {
    this.assertCurrent(id)
    this.#refreshing.add(id)
    return () => this.#refreshing.delete(id)
  }
  readonly #sessions = new Map<string, ReviewSession>()

  constructor(private readonly eventBus: EventBus) {}

  add(session: ReviewSession): void {
    if (this.#sessions.has(session.id)) {
      throw new DuplicateSessionError(session.id)
    }

    const stored = structuredClone(session)
    this.#sessions.set(stored.id, stored)
    this.eventBus.publish({ type: 'session.added', payload: structuredClone(stored) })
  }

  replace(session: ReviewSession): void {
    if (!this.#sessions.has(session.id)) {
      throw new SessionNotFoundError(session.id)
    }

    const stored = structuredClone(session)
    this.#sessions.set(stored.id, stored)
    this.eventBus.publish({ type: 'session.updated', payload: structuredClone(stored) })
  }

  remove(id: string): boolean {
    if (!this.#sessions.delete(id)) return false

    this.eventBus.publish({ type: 'session.removed', payload: { id } })
    return true
  }

  get(id: string): ReviewSession | undefined {
    const session = this.#sessions.get(id)
    return session ? structuredClone(session) : undefined
  }

  list(): ReviewSession[] {
    return [...this.#sessions.values()].map((session) => structuredClone(session))
  }
}
