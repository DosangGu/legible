import { randomUUID } from 'node:crypto'
import type { RefreshReviewResponse, ReviewSession, ReviewUpdate } from '@legible/protocol'
import type { ChatService } from '../chats/service.js'
import type { CommentRelocator } from '../comments/relocate.js'
import { ServiceError } from '../common/service-error.js'
import type { SessionDiffService } from '../diffs/service.js'
import type { PullRequestReader } from '../github/client.js'
import type { RepositoryService } from '../repos/service.js'
import type { ReviewWorktrees } from '../worktrees/manager.js'
import type { SessionMutationQueue } from './mutation-queue.js'
import type { SessionPersistence } from './persistence.js'
import type { SessionRegistry } from './session-registry.js'

export class RefreshReviewService {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly repos: RepositoryService,
    private readonly github: PullRequestReader,
    private readonly worktrees: ReviewWorktrees,
    private readonly diffs: SessionDiffService,
    private readonly relocator: CommentRelocator,
    private readonly chats: ChatService,
    private readonly persistence: SessionPersistence,
    private readonly mutations: SessionMutationQueue,
  ) {}

  async check(id: string): Promise<ReviewUpdate> {
    const session = this.session(id)
    const pull = await this.pull(session)
    this.sessions.assertMutable(id)
    return {
      reviewRevision: session.reviewRevision ?? 0,
      pinnedHeadSha: session.headSha,
      headSha: pull.headSha,
      baseTipSha: pull.baseSha,
      baseRef: pull.baseRef,
      headChanged: pull.headSha !== session.headSha,
      baseChanged:
        session.baseTipSha === undefined
          ? null
          : session.baseTipSha !== pull.baseSha || session.baseRef !== pull.baseRef,
    }
  }

  refresh(id: string): Promise<RefreshReviewResponse> {
    return this.mutations.run(id, async () => {
      const previous = this.session(id)
      if (this.chats.isBusy(id))
        throw new ServiceError('review_busy', 'Stop the active agent before refreshing', 409)
      if (
        previous.submission &&
        (previous.submission.status !== 'submitted' ||
          previous.submission.cleanup.status !== 'complete')
      )
        throw new ServiceError(
          'review_locked',
          'Resolve submission and complete worktree cleanup before continuing',
          409,
        )
      const release = this.sessions.beginRefresh(id)
      const resume = await this.persistence.suspend(id)
      let candidate: ReviewSession | undefined
      let committed = false
      try {
        const pull = await this.pull(previous)
        const generation = randomUUID()
        const prepared = await this.worktrees.prepare(previous.repoId, pull, generation)
        candidate = {
          ...previous,
          headSha: prepared.headSha,
          baseSha: prepared.baseSha,
          baseTipSha: pull.baseSha,
          baseRef: pull.baseRef,
          worktreePath: prepared.path,
          worktreeGeneration: generation,
          reviewRevision: (previous.reviewRevision ?? 0) + 1,
          pullRequest: { title: pull.title, url: pull.url },
        }
        if (
          !previous.submission &&
          previous.headSha === candidate.headSha &&
          previous.baseSha === candidate.baseSha
        ) {
          await this.worktrees.remove(candidate)
          candidate = undefined
          const unchanged = {
            ...previous,
            baseTipSha: pull.baseSha,
            baseRef: pull.baseRef,
            pullRequest: { title: pull.title, url: pull.url },
          }
          await this.persistence.save(unchanged)
          resume()
          release()
          this.sessions.replace(unchanged)
          return { session: unchanged, changed: false }
        }
        await this.diffs.get(candidate)
        if (previous.submission?.status === 'submitted') {
          candidate.submissionHistory = [
            ...(previous.submissionHistory ?? []),
            {
              reviewRevision: previous.reviewRevision ?? 0,
              headSha: previous.headSha,
              baseSha: previous.baseSha,
              comments: previous.comments,
              submission: previous.submission,
            },
          ]
          candidate.comments = []
          delete candidate.submission
        } else candidate.comments = await this.relocator.relocate(previous, candidate)
        const chat = await this.chats.prepareRefresh(id, candidate).catch(() => {
          throw new ServiceError(
            'review_agent_cleanup_failed',
            'Unable to close the old agent and restore its configuration. Resolve configuration recovery before refreshing; the previous review is unchanged.',
            409,
          )
        })
        await this.persistence.saveRevision(candidate, chat).catch(() => {
          throw new ServiceError(
            'review_refresh_save_failed',
            'Unable to save the updated review. The previous review is unchanged; check access and available space in the state directory.',
            500,
          )
        })
        committed = true
        resume()
        release()
        // Restore the chat before publishing session.updated so subscribers see a consistent pair.
        this.chats.restore(id, chat)
        this.sessions.replace(candidate)
        let warning: string | undefined
        if (!previous.submission) {
          try {
            await this.worktrees.remove(previous)
          } catch {
            warning =
              'Review refreshed, but the old worktree could not be removed. Safe cleanup will retry after its retention period.'
          }
        }
        return { session: candidate, changed: true, ...(warning ? { warning } : {}) }
      } catch (error) {
        if (candidate && !committed) {
          try {
            await this.worktrees.remove(candidate)
          } catch {
            throw new ServiceError(
              'refresh_cleanup_failed',
              'Refresh failed; the previous review is unchanged. The unused candidate worktree needs cleanup.',
              500,
            )
          }
        }
        throw error
      } finally {
        resume()
        release()
      }
    })
  }

  private session(id: string): ReviewSession {
    this.sessions.assertMutable(id)
    const session = this.sessions.get(id)
    if (!session) throw new ServiceError('session_not_found', 'Review session not found', 404)
    return session
  }

  private async pull(session: ReviewSession) {
    const repo = this.repos.get(session.repoId)
    const pull = await this.github.getPullRequest(repo.owner, repo.name, session.prNumber)
    if (pull.number !== session.prNumber)
      throw new ServiceError(
        'invalid_pull_request',
        'GitHub returned a different pull request',
        502,
      )
    return pull
  }
}
