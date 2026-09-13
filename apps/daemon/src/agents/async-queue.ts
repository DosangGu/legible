/** A single-consumer queue for an open agent input or output stream. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = []
  #wake: (() => void) | undefined
  #ended = false

  push(value: T): void {
    if (this.#ended) return
    this.#values.push(value)
    this.#wake?.()
  }

  end(): void {
    this.#ended = true
    this.#wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const value = this.#values.shift()
      if (value !== undefined) yield value
      else if (this.#ended) return
      else
        await new Promise<void>((resolve) => {
          this.#wake = resolve
        })
    }
  }
}
