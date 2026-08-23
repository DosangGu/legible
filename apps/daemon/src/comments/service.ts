import { randomUUID } from 'node:crypto'

import type {
  CreateDraftCommentRequest,
  DraftComment,
  ReviewSession,
  UpdateDraftCommentRequest,
} from '@legible/protocol'

import type { SessionDiffService } from '../diffs/service.js'
import type { SessionPersistence } from '../sessions/persistence.js'
import type { SessionRegistry } from '../sessions/session-registry.js'
import type { SessionMutationQueue } from '../sessions/mutation-queue.js'

const maxBodyBytes = 64 * 1024

export class CommentNotFoundError extends Error {}
export class InvalidCommentError extends Error {}
export class CommentSessionNotFoundError extends Error {}

export class CommentService {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly diffs: SessionDiffService,
    private readonly persistence: SessionPersistence,
    private readonly mutations: SessionMutationQueue,
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
  ) {}

  list(sessionId: string): DraftComment[] {
    return this.#session(sessionId).comments
  }

  create(
    sessionId: string,
    request: CreateDraftCommentRequest,
    origin: DraftComment['origin'] = 'human',
  ): Promise<DraftComment> {
    return this.#serialize(sessionId, async () => {
      const session = this.#session(sessionId)
      assertDraft(session)
      const body = validateBody(request.body)
      const range = await this.validateAnchor(session, request)
      const comment: DraftComment = {
        id: this.idFactory(),
        path: request.path,
        line: range.line,
        side: request.side,
        ...(range.startLine !== undefined
          ? { startLine: range.startLine, startSide: request.side }
          : {}),
        body,
        origin,
        createdAt: this.now().toISOString(),
      }
      const updated = { ...session, comments: [...session.comments, comment] }
      await this.persistence.save(updated)
      this.sessions.replace(updated)
      return structuredClone(comment)
    })
  }

  update(
    sessionId: string,
    commentId: string,
    request: UpdateDraftCommentRequest,
  ): Promise<DraftComment> {
    return this.#serialize(sessionId, async () => {
      const session = this.#session(sessionId)
      assertDraft(session)
      const index = session.comments.findIndex((comment) => comment.id === commentId)
      if (index < 0) throw new CommentNotFoundError('Draft comment not found')
      const updatedComment = { ...session.comments[index]!, body: validateBody(request.body) }
      const comments = [...session.comments]
      comments[index] = updatedComment
      const updated = { ...session, comments }
      await this.persistence.save(updated)
      this.sessions.replace(updated)
      return structuredClone(updatedComment)
    })
  }

  remove(sessionId: string, commentId: string): Promise<void> {
    return this.#serialize(sessionId, async () => {
      const session = this.#session(sessionId)
      assertDraft(session)
      const comments = session.comments.filter((comment) => comment.id !== commentId)
      if (comments.length === session.comments.length) {
        throw new CommentNotFoundError('Draft comment not found')
      }
      const updated = { ...session, comments }
      await this.persistence.save(updated)
      this.sessions.replace(updated)
    })
  }

  async validateAnchor(
    session: ReviewSession,
    request: CreateDraftCommentRequest,
  ): Promise<{ line: number; startLine?: number }> {
    if (!request.path || !Number.isSafeInteger(request.line) || request.line < 1) {
      throw new InvalidCommentError('A valid path and line are required')
    }
    if (request.side !== 'LEFT' && request.side !== 'RIGHT') {
      throw new InvalidCommentError('Comment side must be LEFT or RIGHT')
    }
    if ((request.startLine === undefined) !== (request.startSide === undefined)) {
      throw new InvalidCommentError('startLine and startSide must be provided together')
    }
    if (request.startSide !== undefined && request.startSide !== request.side) {
      throw new InvalidCommentError('A comment range must stay on one side')
    }
    if (request.startLine !== undefined && !Number.isSafeInteger(request.startLine)) {
      throw new InvalidCommentError('startLine must be a positive integer')
    }
    const start = request.startLine ?? request.line
    const startLine = Math.min(start, request.line)
    const line = Math.max(start, request.line)
    if (startLine < 1) throw new InvalidCommentError('startLine must be a positive integer')

    const diff = await this.diffs.get(session)
    const file = diff.files.find((candidate) =>
      request.side === 'LEFT'
        ? candidate.oldPath === request.path
        : candidate.newPath === request.path,
    )
    if (!file) throw new InvalidCommentError('Comment path is not present on the requested side')
    const inOneHunk = file.hunks.some((hunk) => {
      const lines = new Set(
        hunk.lines.flatMap((entry) => {
          const value = request.side === 'LEFT' ? entry.leftLine : entry.rightLine
          return value === null ? [] : [value]
        }),
      )
      for (let value = startLine; value <= line; value += 1) {
        if (!lines.has(value)) return false
      }
      return true
    })
    if (!inOneHunk) throw new InvalidCommentError('Comment range must be inside one diff hunk')
    return startLine === line ? { line } : { startLine, line }
  }

  #session(sessionId: string): ReviewSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new CommentSessionNotFoundError('Review session not found')
    return session
  }

  #serialize<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
    return this.mutations.run(sessionId, mutation)
  }
}

function assertDraft(session: ReviewSession): void {
  if (session.submission) throw new InvalidCommentError('Review submission has already started')
}

function validateBody(body: string): string {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new InvalidCommentError('Comment body must not be empty')
  }
  if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
    throw new InvalidCommentError('Comment body must be 64 KiB or smaller')
  }
  return body
}
