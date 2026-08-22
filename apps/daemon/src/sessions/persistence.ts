import type { ReviewSession } from '@legible/protocol'

import type { ChatService } from '../chats/service.js'
import type { EventBus } from '../events/event-bus.js'
import type { SessionRegistry } from './session-registry.js'
import { SessionStore } from './store.js'

const chatDebounceMs = 200

export class SessionPersistence {
  readonly #timers = new Map<string, NodeJS.Timeout>()
  readonly #writes = new Map<string, Promise<void>>()
  readonly #unsubscribe: () => void
  readonly #errors = new Map<string, unknown>()
  #restoring = false

  constructor(
    private readonly store: SessionStore,
    private readonly sessions: SessionRegistry,
    private readonly chats: ChatService,
    eventBus: EventBus,
  ) {
    this.#unsubscribe = eventBus.subscribe((event) => {
      if (this.#restoring) return
      if (event.type === 'session.removed') {
        this.#cancel(event.payload.id)
        void this.#enqueueRemove(event.payload.id).then(
          () => this.#errors.delete(event.payload.id),
          (error: unknown) => this.#errors.set(event.payload.id, error),
        )
      } else if (event.type === 'session.added' || event.type === 'session.updated') {
        this.schedule(event.payload.id, 0)
      } else if (event.type === 'chat.event') {
        const snapshot = this.chats.get(event.payload.sessionId)
        const terminal = snapshot.status === 'idle' || snapshot.status === 'failed'
        this.schedule(event.payload.sessionId, terminal ? 0 : chatDebounceMs)
      }
    })
  }

  async restore(): Promise<void> {
    this.#restoring = true
    try {
      for (const record of await this.store.loadAll()) {
        this.sessions.add(record.session)
        if (record.chat) this.chats.restore(record.session.id, record.chat)
      }
    } finally {
      this.#restoring = false
    }
  }

  schedule(sessionId: string, delayMs = chatDebounceMs): void {
    this.#cancel(sessionId)
    this.#timers.set(
      sessionId,
      setTimeout(() => {
        this.#timers.delete(sessionId)
        void this.flush(sessionId).catch((error: unknown) => this.#errors.set(sessionId, error))
      }, delayMs),
    )
  }

  async save(session: ReviewSession): Promise<void> {
    this.#cancel(session.id)
    await this.#enqueueSave(session.id, session)
    this.#errors.delete(session.id)
  }

  async flush(sessionId: string): Promise<void> {
    this.#cancel(sessionId)
    await this.#enqueueSave(sessionId)
    this.#errors.delete(sessionId)
  }

  async close(): Promise<void> {
    this.#unsubscribe()
    const ids = new Set([
      ...this.sessions.list().map((session) => session.id),
      ...this.#timers.keys(),
    ])
    await Promise.all([...ids].map((id) => this.flush(id)))
    await Promise.allSettled(this.#writes.values())
    if (this.#errors.size > 0) {
      throw new AggregateError(this.#errors.values(), 'One or more sessions could not be persisted')
    }
  }

  #enqueueSave(sessionId: string, override?: ReviewSession): Promise<void> {
    return this.#enqueue(sessionId, async () => {
      const session = override ?? this.sessions.get(sessionId)
      if (!session) return
      const chat = this.chats.exportState(sessionId)
      await this.store.save({
        version: 1,
        session,
        ...(chat ? { chat } : {}),
      })
    })
  }

  #enqueueRemove(sessionId: string): Promise<void> {
    return this.#enqueue(sessionId, () => this.store.remove(sessionId))
  }

  #enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#writes.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.#writes.set(sessionId, next)
    void next.then(
      () => {
        if (this.#writes.get(sessionId) === next) this.#writes.delete(sessionId)
      },
      () => {
        if (this.#writes.get(sessionId) === next) this.#writes.delete(sessionId)
      },
    )
    return next
  }

  #cancel(sessionId: string): void {
    const timer = this.#timers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.#timers.delete(sessionId)
  }
}
