import type { ReviewSession } from '@legible/protocol'

import type { EventBus } from '../events/event-bus.js'

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
