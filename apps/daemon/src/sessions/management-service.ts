import type { ReviewSession } from '@legible/protocol'
import type { ChatService } from '../chats/service.js'
import { ServiceError } from '../common/service-error.js'
import type { SessionMutationQueue } from './mutation-queue.js'
import type { SessionPersistence } from './persistence.js'
import type { SessionRegistry } from './session-registry.js'
import type { ReviewWorktrees } from '../worktrees/manager.js'
import { DirtyWorktreeError, WorktreePathConflictError } from '../worktrees/service.js'

/** Archiving changes visibility only; it never removes review data or worktrees. */
export class SessionManagementService {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly chats: ChatService,
    private readonly persistence: SessionPersistence,
    private readonly mutations: SessionMutationQueue,
    private readonly worktrees: ReviewWorktrees,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async archive(id: string, archived: boolean): Promise<ReviewSession> {
    this.sessions.assertCurrent(id)
    if (archived) {
      if (this.mutations.isPending(id))
        throw new ServiceError(
          'review_busy',
          'Wait for the current review operation before archiving',
          409,
        )
      this.#assertIdle(id)
    }
    return this.#update(id, archived, false)
  }

  open(id: string): Promise<ReviewSession> {
    return this.#update(id, false, true)
  }

  async deleteArchived(id: string): Promise<void> {
    this.sessions.assertCurrent(id)
    if (this.mutations.isPending(id))
      throw new ServiceError(
        'review_busy',
        'Wait for the current review operation before deleting',
        409,
      )
    await this.mutations.run(id, async () => {
      this.sessions.assertCurrent(id)
      const previous = this.sessions.get(id)
      if (!previous) throw new ServiceError('session_not_found', 'Review session not found', 404)
      if (!previous.archivedAt)
        throw new ServiceError('review_not_archived', 'Archive this review before deleting it', 409)
      this.#assertIdle(id)
      const release = this.sessions.beginUpdate(id)
      try {
        if (!previous.deletionRequestedAt) {
          const pending = { ...previous, deletionRequestedAt: this.now().toISOString() }
          await this.persistence.save(pending).catch(() => {
            throw new ServiceError(
              'session_save_failed',
              'Unable to save the deletion request; the review was preserved',
              500,
            )
          })
          this.sessions.replace(pending)
        }
        try {
          await this.worktrees.remove(previous)
        } catch (error) {
          if (error instanceof DirtyWorktreeError)
            throw new ServiceError(
              'worktree_dirty',
              'Review deletion is pending: clean or back up the worktree changes, then retry',
              409,
            )
          if (error instanceof WorktreePathConflictError)
            throw new ServiceError(
              'worktree_path_conflict',
              'Review deletion is pending: the managed worktree path is unsafe; no files were removed',
              409,
            )
          throw error
        }
        await this.persistence.removeDurably(id)
        this.sessions.remove(id)
      } finally {
        release()
      }
    })
  }

  /** Resume durable deletion intents after restoring repositories and sessions. */
  async recoverDeletions(): Promise<Array<{ id: string; error: unknown }>> {
    const failures: Array<{ id: string; error: unknown }> = []
    for (const session of this.sessions.list()) {
      if (!session.deletionRequestedAt) continue
      try {
        await this.deleteArchived(session.id)
      } catch (error) {
        failures.push({ id: session.id, error })
      }
    }
    return failures
  }

  #assertIdle(id: string): void {
    const session = this.sessions.get(id)
    if (!session) throw new ServiceError('session_not_found', 'Review session not found', 404)
    if (this.chats.isBusy(id))
      throw new ServiceError('review_busy', 'Stop the active agent before archiving', 409)
    if (
      session.submission &&
      (session.submission.status !== 'submitted' ||
        session.submission.cleanup.status !== 'complete')
    )
      throw new ServiceError(
        'review_locked',
        'Resolve submission and finish cleanup before archiving',
        409,
      )
  }

  #update(id: string, archived: boolean, touch: boolean): Promise<ReviewSession> {
    return this.mutations.run(id, async () => {
      this.sessions.assertCurrent(id)
      const previous = this.sessions.get(id)
      if (!previous) throw new ServiceError('session_not_found', 'Review session not found', 404)
      if (previous.deletionRequestedAt)
        throw new ServiceError('review_deleting', 'This review is pending deletion', 409)
      if (archived) this.#assertIdle(id)
      const release =
        archived || previous.archivedAt ? this.sessions.beginUpdate(id) : () => undefined
      try {
        const session = { ...previous }
        if (archived) session.archivedAt ??= this.now().toISOString()
        else delete session.archivedAt
        if (touch) session.lastOpenedAt = this.now().toISOString()
        await this.persistence.save(session).catch(() => {
          throw new ServiceError(
            'session_save_failed',
            'Unable to save review visibility; the previous state was preserved',
            500,
          )
        })
        this.sessions.replace(session)
        return session
      } finally {
        release()
      }
    })
  }
}
