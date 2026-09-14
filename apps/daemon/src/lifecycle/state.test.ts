import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { DaemonLifecycle } from './state.js'
import { deferred } from '../testing/deferred.js'

describe('Daemon lifecycle gate', () => {
  it('blocks startup and shutdown traffic, and atomically refuses stop during mutations or AI turns', async () => {
    let busy = false
    const lifecycle = new DaemonLifecycle(() => busy)
    const app = Fastify()
    lifecycle.install(app)
    const gate = deferred()
    const handler = vi.fn(async () => {
      await gate.promise
      return { ok: true }
    })
    app.get('/api/events', async () => ({}))
    app.post('/write', handler)
    try {
      expect((await app.inject('/api/events')).statusCode).toBe(503)
      expect(lifecycle.requestStop()).toBe(false)
      lifecycle.phase = 'ready'
      const writing = app.inject({ url: '/write', method: 'POST' }).then((response) => response)
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
      expect(lifecycle.requestStop()).toBe(false)
      gate.resolve()
      await writing
      busy = true
      expect(lifecycle.requestStop()).toBe(false)
      busy = false
      expect(lifecycle.requestStop()).toBe(true)
      expect((await app.inject({ url: '/write', method: 'POST' })).statusCode).toBe(503)
      expect(handler).toHaveBeenCalledOnce()
    } finally {
      gate.resolve()
      await app.close()
    }
  })
})
