import { randomUUID } from 'node:crypto'
import {
  AgentBackendKind,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ReviewConfig,
  type ReviewSession,
} from '@legible/protocol'
import * as z from 'zod/v4'

import { ServiceError } from '../common/service-error.js'
import type { PullRequestReader } from '../github/client.js'
import type { PreflightService } from '../preflight/service.js'
import { normalizeRepoId, type RepositoryService } from '../repos/service.js'
import type { ReviewWorktrees } from '../worktrees/manager.js'
import { SessionMutationQueue } from './mutation-queue.js'
import type { SessionRegistry } from './session-registry.js'
import type { SessionPersistence } from './persistence.js'

const requestSchema = z
  .object({
    repoId: z.string().min(1),
    prNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    config: z
      .object({
        main: z
          .object({
            backend: z.enum(AgentBackendKind),
            model: z.string().max(256).optional(),
            effort: z.string().max(256).optional(),
            shell: z.enum(['none', 'git', 'broad']),
            network: z.enum(['off', 'fetch', 'free']),
            onOutOfScope: z.literal('deny'),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

export function parseCreateSessionRequest(input: unknown): CreateSessionRequest {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success)
    throw new ServiceError(
      'invalid_session_request',
      'Select a repository, PR number, and supported agent configuration',
    )
  const { main } = parsed.data.config
  if (
    main.backend === AgentBackendKind.Claude &&
    (main.shell !== 'none' || main.network === 'free')
  )
    throw new ServiceError(
      'unsupported_agent_configuration',
      'Claude requires shell: none and network: off or fetch',
    )
  return {
    ...parsed.data,
    repoId: normalizeRepoId(parsed.data.repoId),
    config: parsed.data.config as ReviewConfig,
  }
}

export class OpenReviewService {
  readonly #queue = new SessionMutationQueue()
  constructor(
    private readonly repos: RepositoryService,
    private readonly github: PullRequestReader,
    private readonly worktrees: ReviewWorktrees,
    private readonly sessions: SessionRegistry,
    private readonly persistence: SessionPersistence,
    private readonly mutations: SessionMutationQueue,
    private readonly preflight: PreflightService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  open(input: unknown): Promise<CreateSessionResponse> {
    const request = parseCreateSessionRequest(input)
    return this.#queue.run(`${request.repoId}#${String(request.prNumber)}`, async () => {
      const previous = this.sessions
        .list()
        .find(
          (session) =>
            session.repoId.toLowerCase() === request.repoId &&
            session.prNumber === request.prNumber,
        )
      if (previous) return { session: await this.touch(previous.id), reused: true }
      this.preflight.assertTools(['git', 'gh'])
      const repo = this.repos.get(request.repoId)
      const pull = await this.github.getPullRequest(repo.owner, repo.name, request.prNumber)
      if (pull.number !== request.prNumber)
        throw new ServiceError(
          'invalid_pull_request',
          'GitHub returned a different pull request',
          502,
        )
      const prepared = await this.worktrees.prepare(repo.id, pull)
      const session: ReviewSession = {
        id: randomUUID(),
        repoId: repo.id,
        prNumber: pull.number,
        headSha: prepared.headSha,
        baseSha: prepared.baseSha,
        worktreePath: prepared.path,
        config: request.config,
        comments: [],
        createdAt: this.now().toISOString(),
        lastOpenedAt: this.now().toISOString(),
        pullRequest: { title: pull.title, url: pull.url },
      }
      try {
        await this.persistence.save(session)
      } catch {
        let cleanupFailed = false
        if (!prepared.reused)
          await this.worktrees.remove(session).catch(() => {
            cleanupFailed = true
          })
        throw new ServiceError(
          'session_save_failed',
          cleanupFailed
            ? 'Unable to save the review. Its new worktree could not be cleaned up; existing data was preserved.'
            : 'Unable to save the review. Retry after fixing access to the state directory.',
          500,
        )
      }
      this.sessions.add(session)
      return { session, reused: false }
    })
  }

  touch(id: string): Promise<ReviewSession> {
    return this.mutations.run(id, async () => {
      const session = this.sessions.get(id)
      if (!session) throw new ServiceError('session_not_found', 'Review session not found', 404)
      const updated = { ...session, lastOpenedAt: this.now().toISOString() }
      try {
        await this.persistence.save(updated)
      } catch {
        throw new ServiceError('session_save_failed', 'Unable to update recent reviews', 500)
      }
      this.sessions.replace(updated)
      return updated
    })
  }
}
