import type { ReviewSession, ReviewSubmission, SubmitReviewRequest } from '@legible/protocol'

import type { ChatService } from '../chats/service.js'
import type { CommentService } from '../comments/service.js'
import { GitHubClientError, type GitHubClient, type GitHubReview } from '../github/client.js'
import type { SessionMutationQueue } from '../sessions/mutation-queue.js'
import type { SessionPersistence } from '../sessions/persistence.js'
import type { SessionRegistry } from '../sessions/session-registry.js'
import type { WorktreeService } from '../worktrees/service.js'

const maxBodyBytes = 64 * 1024

export class SubmissionSessionNotFoundError extends Error {}
export class InvalidSubmissionError extends Error {}
export class SubmissionBusyError extends Error {}
export class SubmissionAlreadyStartedError extends Error {}
export class StaleHeadError extends Error {
  constructor(
    readonly pinnedHeadSha: string,
    readonly currentHeadSha: string,
  ) {
    super('The pull request HEAD has changed')
  }
}
export class SubmissionGitHubError extends Error {
  constructor(readonly status?: number) {
    super('GitHub review submission failed')
  }
}

export class SubmissionService {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly persistence: SessionPersistence,
    private readonly mutations: SessionMutationQueue,
    private readonly comments: CommentService,
    private readonly chats: ChatService,
    private readonly worktrees: WorktreeService,
    private readonly github: GitHubClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  submit(sessionId: string, request: SubmitReviewRequest): Promise<ReviewSession> {
    return this.mutations.run(sessionId, async () => {
      const session = this.#session(sessionId)
      if (session.submission)
        throw new SubmissionAlreadyStartedError('Review submission already started')
      if (this.chats.isBusy(sessionId)) {
        throw new SubmissionBusyError('Wait for the active chat turn before submitting')
      }
      const body = validateRequest(request)
      const { owner, repo } = parseRepoId(session.repoId)
      const currentHeadSha = await this.github.getPullHead(owner, repo, session.prNumber)
      const staleHead = currentHeadSha !== session.headSha
      if (staleHead && !request.allowStaleHead) {
        throw new StaleHeadError(session.headSha, currentHeadSha)
      }
      for (const comment of session.comments) {
        await this.comments.validateAnchor(session, comment)
      }

      const marker = `<!-- legible-review-session:${session.id} -->`
      const startedAt = this.now().toISOString()
      const submission: ReviewSubmission = {
        status: 'submitting',
        event: request.event,
        ...(body ? { body } : {}),
        marker,
        startedAt,
        currentHeadSha,
        staleHead,
      }
      const submitting = { ...session, submission }
      await this.#replace(submitting)

      try {
        const review = await this.github.createReview({
          owner,
          repo,
          pullNumber: session.prNumber,
          commitId: session.headSha,
          event: request.event,
          body: body ? `${body}\n\n${marker}` : marker,
          comments: session.comments,
        })
        return await this.#complete(submitting, review)
      } catch (error) {
        if (
          error instanceof GitHubClientError &&
          error.status !== undefined &&
          error.status < 500
        ) {
          await this.#replace(withoutSubmission(submitting))
          throw new SubmissionGitHubError(error.status)
        }
        const uncertain = {
          ...submitting,
          submission: { ...submission, status: 'uncertain' as const },
        }
        await this.#replace(uncertain)
        try {
          const reconciled = await this.#reconcile(uncertain)
          if (reconciled.submission?.status === 'submitted') return reconciled
          throw new SubmissionGitHubError(
            error instanceof GitHubClientError ? error.status : undefined,
          )
        } catch (reconcileError) {
          if (reconcileError instanceof SubmissionGitHubError) throw reconcileError
          throw new SubmissionGitHubError()
        }
      }
    })
  }

  reconcile(sessionId: string): Promise<ReviewSession> {
    return this.mutations.run(sessionId, async () => {
      try {
        return await this.#reconcile(this.#session(sessionId))
      } catch (error) {
        if (error instanceof GitHubClientError) throw new SubmissionGitHubError(error.status)
        throw error
      }
    })
  }

  cleanup(sessionId: string): Promise<ReviewSession> {
    return this.mutations.run(sessionId, async () => {
      const session = this.#session(sessionId)
      if (session.submission?.status !== 'submitted') {
        throw new InvalidSubmissionError('There is no submitted review to clean up')
      }
      return this.#cleanup(session)
    })
  }

  async #reconcile(session: ReviewSession): Promise<ReviewSession> {
    const submission = session.submission
    if (!submission || submission.status === 'submitted') return session
    const { owner, repo } = parseRepoId(session.repoId)
    const reviews = await this.github.listReviews(owner, repo, session.prNumber)
    const review = reviews.find((candidate) => candidate.body.includes(submission.marker))
    if (review) return this.#complete(session, review)
    const draft = withoutSubmission(session)
    await this.#replace(draft)
    return draft
  }

  async #complete(session: ReviewSession, review: GitHubReview): Promise<ReviewSession> {
    const pending: ReviewSession = {
      ...session,
      submission: {
        ...session.submission!,
        status: 'submitted',
        githubReviewId: review.id,
        htmlUrl: review.htmlUrl,
        submittedAt: review.submittedAt || this.now().toISOString(),
        cleanup: { status: 'pending' },
      },
    }
    await this.#replace(pending)
    return this.#cleanup(pending)
  }

  async #cleanup(session: ReviewSession): Promise<ReviewSession> {
    let cleanup: Extract<ReviewSubmission, { status: 'submitted' }>['cleanup']
    try {
      await this.chats.seal(session.id)
      await this.worktrees.remove(session.prNumber)
      cleanup = { status: 'complete' }
    } catch (error) {
      cleanup = {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Worktree cleanup failed',
      }
    }
    const updated = {
      ...session,
      submission: { ...session.submission!, cleanup } as Extract<
        ReviewSubmission,
        { status: 'submitted' }
      >,
    }
    await this.#replace(updated)
    return updated
  }

  async #replace(session: ReviewSession): Promise<void> {
    await this.persistence.save(session)
    this.sessions.replace(session)
  }

  #session(sessionId: string): ReviewSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new SubmissionSessionNotFoundError('Review session not found')
    return session
  }
}

function validateRequest(request: SubmitReviewRequest): string | undefined {
  if (
    request.event !== 'COMMENT' &&
    request.event !== 'REQUEST_CHANGES' &&
    request.event !== 'APPROVE'
  ) {
    throw new InvalidSubmissionError('A valid review event is required')
  }
  const body = request.body?.trim()
  if ((request.event === 'COMMENT' || request.event === 'REQUEST_CHANGES') && !body) {
    throw new InvalidSubmissionError('A review body is required for this event')
  }
  if (body && Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
    throw new InvalidSubmissionError('Review body must be 64 KiB or smaller')
  }
  return body
}

function parseRepoId(repoId: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repoId.split('/')
  if (!owner || !repo || rest.length > 0) throw new InvalidSubmissionError('Invalid repository id')
  return { owner, repo }
}

function withoutSubmission(session: ReviewSession): ReviewSession {
  const draft = structuredClone(session)
  delete draft.submission
  return draft
}
