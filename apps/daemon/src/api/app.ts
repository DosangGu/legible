import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'

import type {
  ApiError,
  DaemonEventEnvelope,
  DaemonHealth,
  DaemonSnapshot,
  DiffSide,
} from '@legible/protocol'

import { ReviewFileNotFoundError, ReviewFileUnavailableError } from '../diffs/file-service.js'
import { DiffUnavailableError } from '../diffs/service.js'
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

  app.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/diff',
    async (request, reply) => {
      const session = options.services.sessions.get(request.params.sessionId)
      if (!session) {
        const response: ApiError = {
          error: { code: 'session_not_found', message: 'Review session not found' },
        }
        return reply.code(404).send(response)
      }

      try {
        return await options.services.diffs.get(session)
      } catch (error) {
        if (error instanceof DiffUnavailableError) {
          const response: ApiError = {
            error: { code: 'diff_unavailable', message: 'Diff unavailable for this session' },
          }
          return reply.code(409).send(response)
        }
        throw error
      }
    },
  )

  app.get<{
    Params: { sessionId: string }
    Querystring: { path?: unknown; side?: unknown }
  }>('/api/sessions/:sessionId/file', async (request, reply) => {
    const session = options.services.sessions.get(request.params.sessionId)
    if (!session) {
      const response: ApiError = {
        error: { code: 'session_not_found', message: 'Review session not found' },
      }
      return reply.code(404).send(response)
    }

    const { path, side } = request.query
    if (typeof path !== 'string' || path.length === 0 || !isDiffSide(side)) {
      const response: ApiError = {
        error: { code: 'invalid_file_request', message: 'A file path and side are required' },
      }
      return reply.code(400).send(response)
    }

    try {
      return await options.services.files.get(session, path, side)
    } catch (error) {
      if (error instanceof ReviewFileNotFoundError) {
        const response: ApiError = {
          error: { code: 'file_not_found', message: 'File is not part of this review diff' },
        }
        return reply.code(404).send(response)
      }
      if (error instanceof ReviewFileUnavailableError) {
        const response: ApiError = {
          error: { code: 'file_unavailable', message: 'File unavailable for this session' },
        }
        return reply.code(409).send(response)
      }
      throw error
    }
  })

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

function isDiffSide(value: unknown): value is DiffSide {
  return value === 'LEFT' || value === 'RIGHT'
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
