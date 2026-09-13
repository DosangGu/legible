import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { BrowserAccess } from './access.js'
import { installWeb } from './static.js'
import { ServiceError } from '../common/service-error.js'
import { GitHubClientError } from '../github/client.js'
import {
  DirtyWorktreeError,
  GitCommandError,
  WorktreePathConflictError,
} from '../worktrees/service.js'

import type {
  ApiError,
  DaemonEventEnvelope,
  DaemonHealth,
  DaemonSnapshot,
  DiffSide,
  SubmitReviewRequest,
} from '@legible/protocol'

import {
  ChatBusyError,
  ChatItemNotFoundError,
  ChatNotFoundError,
  ChatRetryUnavailableError,
  ChatUnavailableError,
  InvalidChatMessageError,
} from '../chats/service.js'
import {
  CommentNotFoundError,
  CommentSessionNotFoundError,
  InvalidCommentError,
} from '../comments/service.js'
import { ReviewFileNotFoundError, ReviewFileUnavailableError } from '../diffs/file-service.js'
import { DiffUnavailableError } from '../diffs/service.js'
import type { DaemonServices } from '../services.js'
import {
  InvalidSubmissionError,
  StaleHeadError,
  SubmissionAlreadyStartedError,
  SubmissionBusyError,
  SubmissionGitHubError,
  SubmissionSessionNotFoundError,
} from '../submissions/service.js'

export type BuildAppOptions = {
  services: DaemonServices
  version: string
  logger?: boolean
  now?: () => Date
  startedAtMs?: number
  access: BrowserAccess
  webDirectory?: string
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date())
  const startedAtMs = options.startedAtMs ?? now().getTime()
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.body',
            'res.headers["set-cookie"]',
          ],
        }
      : false,
    bodyLimit: 128 * 1024,
  })

  options.access.install(app)
  if (options.webDirectory) installWeb(app, options.webDirectory)

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

  app.get('/api/repos', async () => options.services.repos.list())
  app.post<{ Body: { path?: unknown } }>('/api/repos', async (request, reply) => {
    if (typeof request.body?.path !== 'string' || request.body.path.length > 4096)
      throw new ServiceError('invalid_repo_path', 'Enter an absolute repository path')
    options.services.preflight.assertTools(['git'])
    return reply.code(201).send(await options.services.repos.register(request.body.path))
  })
  app.get<{ Params: { owner: string; name: string }; Querystring: { page?: string } }>(
    '/api/repos/:owner/:name/pulls',
    async (request) => {
      const page = request.query.page === undefined ? 1 : Number(request.query.page)
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000)
        throw new ServiceError('invalid_page', 'Invalid PR list page')
      options.services.preflight.assertTools(['gh'])
      const repo = options.services.repos.get(`${request.params.owner}/${request.params.name}`)
      return options.services.pullRequests.listPullRequests(repo.owner, repo.name, page)
    },
  )
  app.post<{ Body: unknown }>('/api/sessions', async (request, reply) => {
    const result = await options.services.openReviews.open(request.body)
    return reply.code(result.reused ? 200 : 201).send(result)
  })
  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/open', async (request) =>
    options.services.openReviews.touch(request.params.sessionId),
  )

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
    const session = options.services.sessions.get(request.params.sessionId)
    if (session) return session
    const response: ApiError = {
      error: { code: 'session_not_found', message: 'Review session not found' },
    }
    return reply.code(404).send(response)
  })

  app.post<{
    Params: { sessionId: string }
    Body: { event?: unknown; body?: unknown; allowStaleHead?: unknown }
  }>('/api/sessions/:sessionId/submission', async (request) => {
    const body = request.body
    if (
      (body?.event !== 'COMMENT' &&
        body?.event !== 'REQUEST_CHANGES' &&
        body?.event !== 'APPROVE') ||
      (body.body !== undefined && typeof body.body !== 'string') ||
      (body.allowStaleHead !== undefined && typeof body.allowStaleHead !== 'boolean')
    ) {
      throw new InvalidSubmissionError('A valid review event and body are required')
    }
    const submission: SubmitReviewRequest = {
      event: body.event,
      ...(body.body === undefined ? {} : { body: body.body }),
      ...(body.allowStaleHead === undefined ? {} : { allowStaleHead: body.allowStaleHead }),
    }
    return options.services.submissions.submit(request.params.sessionId, submission)
  })

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/submission/reconcile',
    (request) => options.services.submissions.reconcile(request.params.sessionId),
  )

  app.route<{ Params: { sessionId: string }; Body: unknown }>({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/sessions/:sessionId/mcp',
    handler: async (request, reply) => {
      reply.hijack()
      await options.services.mcp.handle(
        request.params.sessionId,
        request.raw,
        reply.raw,
        request.body,
      )
    },
  })

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/submission/cleanup',
    (request) => options.services.submissions.cleanup(request.params.sessionId),
  )

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/comments', (request) =>
    options.services.comments.list(request.params.sessionId),
  )

  app.post<{
    Params: { sessionId: string }
    Body: {
      path?: unknown
      line?: unknown
      side?: unknown
      startLine?: unknown
      startSide?: unknown
      body?: unknown
    }
  }>('/api/sessions/:sessionId/comments', async (request, reply) => {
    const body = request.body
    if (
      typeof body?.path !== 'string' ||
      typeof body.line !== 'number' ||
      (body.side !== 'LEFT' && body.side !== 'RIGHT') ||
      typeof body.body !== 'string' ||
      (body.startLine !== undefined && typeof body.startLine !== 'number') ||
      (body.startSide !== undefined && body.startSide !== 'LEFT' && body.startSide !== 'RIGHT')
    ) {
      throw new InvalidCommentError('A valid comment body and anchor are required')
    }
    const comment = await options.services.comments.create(request.params.sessionId, {
      path: body.path,
      line: body.line,
      side: body.side,
      ...(body.startLine !== undefined ? { startLine: body.startLine } : {}),
      ...(body.startSide !== undefined ? { startSide: body.startSide } : {}),
      body: body.body,
    })
    return reply.code(201).send(comment)
  })

  app.patch<{
    Params: { sessionId: string; commentId: string }
    Body: { body?: unknown }
  }>('/api/sessions/:sessionId/comments/:commentId', async (request) => {
    if (typeof request.body?.body !== 'string') {
      throw new InvalidCommentError('A comment body is required')
    }
    return options.services.comments.update(request.params.sessionId, request.params.commentId, {
      body: request.body.body,
    })
  })

  app.delete<{ Params: { sessionId: string; commentId: string } }>(
    '/api/sessions/:sessionId/comments/:commentId',
    async (request, reply) => {
      await options.services.comments.remove(request.params.sessionId, request.params.commentId)
      return reply.code(204).send()
    },
  )

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/chat', (request) =>
    options.services.chats.get(request.params.sessionId),
  )

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/chat/start',
    (request, reply) =>
      reply.code(202).send(options.services.chats.startReview(request.params.sessionId)),
  )

  app.post<{ Params: { sessionId: string }; Body: { message?: unknown; itemId?: unknown } }>(
    '/api/sessions/:sessionId/chat/messages',
    (request, reply) => {
      if (
        typeof request.body?.message !== 'string' ||
        (request.body.itemId !== undefined &&
          (typeof request.body.itemId !== 'string' || request.body.itemId.length === 0))
      ) {
        throw new InvalidChatMessageError('A message is required')
      }
      return reply
        .code(202)
        .send(
          options.services.chats.send(
            request.params.sessionId,
            request.body.message,
            request.body.itemId,
          ),
        )
    },
  )

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/chat/interrupt',
    (request, reply) =>
      reply.code(202).send(options.services.chats.interrupt(request.params.sessionId)),
  )

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/chat/retry',
    (request, reply) =>
      reply.code(202).send(options.services.chats.retry(request.params.sessionId)),
  )

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

  app.addHook('onClose', async () => {
    try {
      await options.services.persistence.close()
    } finally {
      try {
        await options.services.chats.close()
      } finally {
        await options.services.mcp.close()
      }
    }
  })

  app.setNotFoundHandler(async (_request, reply) => {
    const response: ApiError = {
      error: { code: 'not_found', message: 'Route not found' },
    }
    return reply.code(404).send(response)
  })

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ServiceError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } })
    if (error instanceof GitHubClientError) {
      const status =
        error.status === 401 || error.status === 403 || error.status === 404 ? error.status : 502
      return reply.code(status).send({
        error: {
          code: 'github_request_failed',
          message:
            status === 404
              ? 'PR not found or inaccessible on GitHub'
              : 'GitHub request failed. Check authentication, access, and rate limits, then retry.',
        },
      })
    }
    if (
      error instanceof GitCommandError ||
      error instanceof DirtyWorktreeError ||
      error instanceof WorktreePathConflictError
    ) {
      return reply.code(409).send({
        error: {
          code: 'worktree_unavailable',
          message:
            'Cannot safely prepare this worktree. Check Git access and local changes, then retry.',
        },
      })
    }
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: 'invalid_request', message: 'Invalid request' } })
    }
    const commentError = mapCommentError(error)
    if (commentError) return reply.code(commentError.status).send(commentError.body)
    const chatError = mapChatError(error)
    if (chatError) return reply.code(chatError.status).send(chatError.body)
    const submissionError = mapSubmissionError(error)
    if (submissionError) return reply.code(submissionError.status).send(submissionError.body)
    request.log.error(error)
    const response: ApiError = {
      error: { code: 'internal_error', message: 'Internal server error' },
    }
    return reply.code(500).send(response)
  })

  return app
}

function mapSubmissionError(
  error: unknown,
): { status: 400 | 401 | 403 | 404 | 409 | 422 | 502; body: ApiError } | undefined {
  if (error instanceof SubmissionSessionNotFoundError) {
    return { status: 404, body: { error: { code: 'session_not_found', message: error.message } } }
  }
  if (error instanceof InvalidSubmissionError) {
    return { status: 400, body: { error: { code: 'invalid_submission', message: error.message } } }
  }
  if (error instanceof SubmissionBusyError) {
    return { status: 409, body: { error: { code: 'submission_busy', message: error.message } } }
  }
  if (error instanceof SubmissionAlreadyStartedError) {
    return {
      status: 409,
      body: { error: { code: 'submission_already_started', message: error.message } },
    }
  }
  if (error instanceof StaleHeadError) {
    return {
      status: 409,
      body: {
        error: {
          code: 'stale_pr_head',
          message: error.message,
          details: {
            pinnedHeadSha: error.pinnedHeadSha,
            currentHeadSha: error.currentHeadSha,
          },
        },
      },
    }
  }
  if (error instanceof SubmissionGitHubError) {
    const status =
      error.status === 401 ? 401 : error.status === 403 ? 403 : error.status === 422 ? 422 : 502
    return {
      status,
      body: { error: { code: 'github_submission_failed', message: error.message } },
    }
  }
  return undefined
}

function mapCommentError(error: unknown): { status: 400 | 404; body: ApiError } | undefined {
  if (error instanceof CommentSessionNotFoundError) {
    return {
      status: 404,
      body: { error: { code: 'session_not_found', message: error.message } },
    }
  }
  if (error instanceof CommentNotFoundError) {
    return {
      status: 404,
      body: { error: { code: 'comment_not_found', message: error.message } },
    }
  }
  if (error instanceof InvalidCommentError) {
    return {
      status: 400,
      body: { error: { code: 'invalid_comment', message: error.message } },
    }
  }
  return undefined
}

function mapChatError(error: unknown): { status: 400 | 404 | 409; body: ApiError } | undefined {
  if (error instanceof ChatNotFoundError) {
    return {
      status: 404,
      body: { error: { code: 'session_not_found', message: error.message } },
    }
  }
  if (error instanceof InvalidChatMessageError) {
    return {
      status: 400,
      body: { error: { code: 'invalid_chat_message', message: error.message } },
    }
  }
  if (error instanceof ChatItemNotFoundError) {
    return {
      status: 404,
      body: { error: { code: 'chat_item_not_found', message: error.message } },
    }
  }
  if (error instanceof ChatUnavailableError) {
    return {
      status: 409,
      body: { error: { code: 'chat_unavailable', message: error.message } },
    }
  }
  if (error instanceof ChatRetryUnavailableError) {
    return {
      status: 409,
      body: { error: { code: 'chat_retry_unavailable', message: error.message } },
    }
  }
  if (error instanceof ChatBusyError) {
    return {
      status: 409,
      body: { error: { code: 'chat_busy', message: error.message } },
    }
  }
  return undefined
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
