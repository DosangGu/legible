import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'

import type { ApiError, DaemonEventEnvelope, DaemonHealth, DaemonSnapshot } from '@legible/protocol'

import type { DaemonServices } from '../services.js'

export type BuildAppOptions = {
  services: DaemonServices
  version: string
  logger?: boolean
  now?: () => Date
  startedAtMs?: number
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date())
  const startedAtMs = options.startedAtMs ?? now().getTime()
  const app = Fastify({ logger: options.logger ?? false })

  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
    },
  })

  app.get('/api/health', async (): Promise<DaemonHealth> => ({
    status: options.services.preflight.getReport().status,
    version: options.version,
    uptimeSeconds: Math.max(0, Math.floor((now().getTime() - startedAtMs) / 1_000)),
  }))

  app.get('/api/preflight', async () => options.services.preflight.getReport())

  app.post('/api/preflight/refresh', async () => options.services.preflight.refresh())

  app.get('/api/sessions', async () => options.services.sessions.list())

  app.get('/api/events', { websocket: true }, (socket) => {
    const send = (event: DaemonEventEnvelope) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(event))
    }
    const unsubscribe = options.services.eventBus.subscribe(send)

    socket.send(JSON.stringify(createSnapshotEvent(options.services, now)))

    socket.once('message', () => socket.close(1008, 'Read-only event stream'))
    socket.once('close', unsubscribe)
    socket.once('error', unsubscribe)
  })

  app.setNotFoundHandler(async (_request, reply) => {
    const response: ApiError = {
      error: { code: 'not_found', message: 'Route not found' },
    }
    return reply.code(404).send(response)
  })

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(error)
    const response: ApiError = {
      error: { code: 'internal_error', message: 'Internal server error' },
    }
    return reply.code(500).send(response)
  })

  return app
}

export function createSnapshotEvent(
  services: DaemonServices,
  now: () => Date = () => new Date(),
): DaemonEventEnvelope {
  const payload: DaemonSnapshot = {
    preflight: services.preflight.getReport(),
    sessions: services.sessions.list(),
  }

  return {
    type: 'daemon.snapshot',
    payload,
    sequence: services.eventBus.sequence,
    emittedAt: now().toISOString(),
  }
}
