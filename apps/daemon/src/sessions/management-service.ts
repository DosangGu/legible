import type { ReviewSession } from '@legible/protocol'
import type { ChatService } from '../chats/service.js'
import { ServiceError } from '../common/service-error.js'
import type { SessionMutationQueue } from './mutation-queue.js'
import type { SessionPersistence } from './persistence.js'
import type { SessionRegistry } from './session-registry.js'

/** Archiving changes visibility only; it never removes review data or worktrees. */
export class SessionManagementService {
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly chats: ChatService,
    private readonly persistence: SessionPersistence,
    private readonly mutations: SessionMutationQueue,
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
