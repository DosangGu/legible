import type { DaemonEvent, DaemonEventEnvelope } from '@legible/protocol'

export type EventListener = (event: DaemonEventEnvelope) => void

export type EventBusOptions = {
  now?: () => Date
  onListenerError?: (error: unknown) => void
}

export class EventBus {
  readonly #listeners = new Set<EventListener>()
  readonly #now: () => Date
  readonly #onListenerError: (error: unknown) => void
  #sequence = 0

  constructor(options: EventBusOptions = {}) {
    this.#now = options.now ?? (() => new Date())
    this.#onListenerError = options.onListenerError ?? (() => undefined)
  }

  get sequence(): number {
    return this.#sequence
  }

  publish(event: DaemonEvent): DaemonEventEnvelope {
    const envelope: DaemonEventEnvelope = {
      ...event,
      sequence: ++this.#sequence,
      emittedAt: this.#now().toISOString(),
    }

    for (const listener of [...this.#listeners]) {
      try {
        listener(structuredClone(envelope))
      } catch (error) {
        this.#onListenerError(error)
      }
    }

    return envelope
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    let subscribed = true

    return () => {
      if (!subscribed) return
      subscribed = false
      this.#listeners.delete(listener)
    }
  }
}
