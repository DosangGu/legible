import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node'
import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type McpHttpHandler,
} from '@modelcontextprotocol/server'
import type { ReviewFocusRequest } from '@legible/protocol'
import * as z from 'zod/v4'

import type { McpServerLease, McpServerProvider } from '../agents/types.js'
import type { CommentService } from '../comments/service.js'
import {
  CommentNotFoundError,
  CommentSessionNotFoundError,
  InvalidCommentError,
} from '../comments/service.js'
import type { EventBus } from '../events/event-bus.js'
import type { SessionRegistry } from '../sessions/session-registry.js'

export const legibleMcpServerName = 'legible_review'
export const legibleMcpTools = [
  'add_comment',
  'edit_comment',
  'remove_comment',
  'list_comments',
  'focus',
] as const

type LeaseRecord = {
  sessionId: string
  handler: McpHttpHandler
  handle(request: IncomingMessage, response: ServerResponse, parsedBody?: unknown): Promise<void>
}

export type ReviewMcpServerOptions = {
  origin: string
  sessions: SessionRegistry
  comments: CommentService
  eventBus: EventBus
  tokenFactory?: () => string
}

export class ReviewMcpServer implements McpServerProvider {
  readonly #leases = new Map<string, LeaseRecord>()
  readonly #tokenFactory: () => string
  #origin: string

  constructor(private readonly options: ReviewMcpServerOptions) {
    this.#origin = normalizeOrigin(options.origin)
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'))
  }

  setOrigin(origin: string): void {
    this.#origin = normalizeOrigin(origin)
  }

  open(sessionId: string, origin: 'codex'): McpServerLease {
    if (!this.options.sessions.get(sessionId)) throw new Error('Review session not found')
    const token = this.#tokenFactory()
    const handler = createMcpHandler(() => this.#createToolServer(sessionId, origin))
    const nodeHandler = toNodeHandler(handler)
    const record: LeaseRecord = {
      sessionId,
      handler,
      handle: (request, response, parsedBody) =>
        nodeHandler(request as unknown as Parameters<typeof nodeHandler>[0], response, parsedBody),
    }
    this.#leases.set(token, record)

    let closed = false
    return {
      spec: {
        name: legibleMcpServerName,
        transport: 'http',
        url: `${this.#origin}/api/sessions/${encodeURIComponent(sessionId)}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
        enabledTools: legibleMcpTools,
        required: true,
      },
      close: async () => {
        if (closed) return
        closed = true
        this.#leases.delete(token)
        await handler.close()
      },
    }
  }

  async handle(
    sessionId: string,
    request: IncomingMessage,
    response: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    if (!localhostHostValidation()(request, response)) return
    if (!localhostOriginValidation()(request, response)) return
    const token = bearerToken(request.headers.authorization)
    const lease = token ? this.#leases.get(token) : undefined
    if (!lease || lease.sessionId !== sessionId) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32_001, message: 'Unauthorized MCP session' },
          id: null,
        }),
      )
      return
    }
    await lease.handle(request, response, parsedBody)
  }

  async close(): Promise<void> {
    const handlers = [...this.#leases.values()].map(({ handler }) => handler)
    this.#leases.clear()
    await Promise.allSettled(handlers.map((handler) => handler.close()))
  }

  #createToolServer(sessionId: string, origin: 'codex'): McpServer {
    const server = new McpServer({ name: legibleMcpServerName, version: '0.0.0' })
    const anchorSchema = {
      path: z.string().min(1),
      line: z.number().int().positive(),
      side: z.enum(['LEFT', 'RIGHT']),
      start_line: z.number().int().positive().optional(),
    }

    server.registerTool(
      'add_comment',
      {
        description: 'Add a draft review comment to the pinned diff.',
        inputSchema: z.object({
          ...anchorSchema,
          body: z
            .string()
            .min(1)
            .max(64 * 1024),
          start_side: z.enum(['LEFT', 'RIGHT']).optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      (input) =>
        toolResult(async () => {
          const comment = await this.options.comments.create(
            sessionId,
            {
              path: input.path,
              line: input.line,
              side: input.side,
              ...(input.start_line === undefined ? {} : { startLine: input.start_line }),
              ...(input.start_side === undefined ? {} : { startSide: input.start_side }),
              body: input.body,
            },
            origin,
          )
          return { comment }
        }),
    )

    server.registerTool(
      'edit_comment',
      {
        description: 'Edit the body of an existing local draft comment.',
        inputSchema: z.object({
          id: z.string().min(1),
          body: z
            .string()
            .min(1)
            .max(64 * 1024),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      (input) =>
        toolResult(async () => ({
          comment: await this.options.comments.update(sessionId, input.id, { body: input.body }),
        })),
    )

    server.registerTool(
      'remove_comment',
      {
        description: 'Remove an existing local draft comment.',
        inputSchema: z.object({ id: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      (input) =>
        toolResult(async () => {
          await this.options.comments.remove(sessionId, input.id)
          return { removedId: input.id }
        }),
    )

    server.registerTool(
      'list_comments',
      {
        description: 'List all local draft comments for this review session.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      () => toolResult(async () => ({ comments: this.options.comments.list(sessionId) })),
    )

    server.registerTool(
      'focus',
      {
        description: 'Focus the Legible diff view on a line or range in the pinned diff.',
        inputSchema: z.object(anchorSchema),
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      (input) =>
        toolResult(async () => {
          const session = this.options.sessions.get(sessionId)
          if (!session) throw new InvalidCommentError('Review session not found')
          if (session.submission) {
            throw new InvalidCommentError('Review submission has already started')
          }
          const range = await this.options.comments.validateAnchor(session, {
            path: input.path,
            line: input.line,
            side: input.side,
            ...(input.start_line === undefined
              ? {}
              : { startLine: input.start_line, startSide: input.side }),
            body: 'focus',
          })
          const payload: ReviewFocusRequest = {
            sessionId,
            path: input.path,
            line: range.line,
            side: input.side,
            ...(range.startLine === undefined ? {} : { startLine: range.startLine }),
          }
          this.options.eventBus.publish({ type: 'review.focus.requested', payload })
          return { focus: payload }
        }),
    )

    return server
  }
}

async function toolResult(
  operation: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  try {
    const result = await operation()
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    }
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: toolErrorMessage(error),
        },
      ],
    }
  }
}

function toolErrorMessage(error: unknown): string {
  return error instanceof InvalidCommentError ||
    error instanceof CommentNotFoundError ||
    error instanceof CommentSessionNotFoundError
    ? error.message
    : 'Legible tool failed'
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value?.startsWith('Bearer ')) return undefined
  const token = value.slice('Bearer '.length)
  return token.length > 0 ? token : undefined
}

function normalizeOrigin(value: string): string {
  const origin = new URL(value).origin
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}
