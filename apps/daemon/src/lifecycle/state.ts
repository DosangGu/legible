import type { FastifyInstance } from 'fastify'
import { ServiceError } from '../common/service-error.js'

export type DaemonPhase = 'starting' | 'ready' | 'stopping'

/** The listener remains owned while startup and shutdown touch persistent state. */
export class DaemonLifecycle {
  phase: DaemonPhase = 'starting'
  #requests = 0
  #drained: Array<() => void> = []

  constructor(private readonly busy: () => boolean) {}

  install(app: FastifyInstance): void {
    app.addHook('onRequest', async (request, reply) => {
      if (this.phase !== 'ready') {
        return reply
          .code(503)
          .header('Retry-After', '1')
          .send({
            error: { code: `daemon_${this.phase}`, message: `Legible is ${this.phase}` },
          })
      }
    })
    const mutate = this.#mutate.bind(this)
    app.addHook('onRoute', (route) => {
      const handler = route.handler
      route.handler = async function (request, reply) {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method))
          return handler.call(this, request, reply)
        return mutate(() => handler.call(this, request, reply))
      }
    })
  }

  async #mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.phase !== 'ready')
      throw new ServiceError('daemon_stopping', 'Legible is stopping', 503)
    this.#requests++
    try {
      // Keep the lease even if the client disconnects before its work completes.
      return await operation()
    } finally {
      this.#requests--
      if (!this.#requests) this.#drained.splice(0).forEach((resolve) => resolve())
    }
  }

  requestStop(): boolean {
    if (this.phase !== 'ready' || this.#requests || this.busy()) return false
    this.phase = 'stopping'
    return true
  }

  async drain(): Promise<void> {
    this.phase = 'stopping'
    if (this.#requests) await new Promise<void>((resolve) => this.#drained.push(resolve))
  }
}
