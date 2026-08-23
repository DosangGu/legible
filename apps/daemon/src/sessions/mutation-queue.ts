export class SessionMutationQueue {
  readonly #mutations = new Map<string, Promise<unknown>>()

  run<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.#mutations.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(mutation)
    this.#mutations.set(sessionId, next)
    void next.then(
      () => {
        if (this.#mutations.get(sessionId) === next) this.#mutations.delete(sessionId)
      },
      () => {
        if (this.#mutations.get(sessionId) === next) this.#mutations.delete(sessionId)
      },
    )
    return next
  }
}
