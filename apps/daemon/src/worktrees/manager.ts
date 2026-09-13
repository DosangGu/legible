import { join, resolve } from 'node:path'
import type { ReviewSession } from '@legible/protocol'

import { ServiceError } from '../common/service-error.js'
import { defaultStateDirectory } from '../common/state.js'
import type { PullRequestDetails } from '../github/client.js'
import type { CommandRunner } from '../preflight/command-runner.js'
import type { RepositoryService } from '../repos/service.js'
import { SessionMutationQueue } from '../sessions/mutation-queue.js'
import { WorktreeService, type PreparedWorktree, type WorktreeSweepResult } from './service.js'

export type ReviewWorktree = PreparedWorktree & { baseSha: string }
export interface ReviewWorktrees {
  prepare(repoId: string, pull: PullRequestDetails): Promise<ReviewWorktree>
  remove(session: Pick<ReviewSession, 'repoId' | 'prNumber' | 'worktreePath'>): Promise<boolean>
}

export class WorktreeManager implements ReviewWorktrees {
  readonly #locks = new SessionMutationQueue()
  readonly #stateDirectory: string
  constructor(
    private readonly repos: RepositoryService,
    private readonly runner: CommandRunner,
    private readonly options: { stateDirectory?: string; ttlMs?: number; now?: () => Date } = {},
  ) {
    this.#stateDirectory = resolve(options.stateDirectory ?? defaultStateDirectory())
  }

  async prepare(repoId: string, pull: PullRequestDetails): Promise<ReviewWorktree> {
    return this.#withRepo(repoId, (worktrees) => worktrees.preparePinned(pull))
  }

  async remove(
    session: Pick<ReviewSession, 'repoId' | 'prNumber' | 'worktreePath'>,
  ): Promise<boolean> {
    const repo = this.repos.get(session.repoId)
    const expected = join(
      this.#stateDirectory,
      'worktrees',
      repo.owner,
      repo.name,
      `pr-${String(session.prNumber)}`,
    )
    if (resolve(session.worktreePath) !== expected)
      throw new ServiceError(
        'worktree_path_conflict',
        'The session worktree does not belong to this registered repository',
        409,
      )
    return this.#withRepo(repo.id, (worktrees) => worktrees.remove(session.prNumber))
  }

  async sweep(activePaths: readonly string[]): Promise<WorktreeSweepResult> {
    const result: WorktreeSweepResult = { removed: [], skipped: [], failed: [] }
    for (const repo of this.repos.list()) {
      try {
        const swept = await this.#withRepo(repo.id, (worktrees) => worktrees.sweep(activePaths))
        result.removed.push(...swept.removed)
        result.skipped.push(...swept.skipped)
        result.failed.push(...swept.failed)
      } catch {
        result.failed.push({
          path: repo.primaryCheckout,
          message: 'Repository unavailable; no worktrees were removed',
        })
      }
    }
    return result
  }

  async #withRepo<T>(id: string, run: (service: WorktreeService) => Promise<T>): Promise<T> {
    const { commonDirectory } = await this.repos.checkout(id)
    return this.#locks.run(commonDirectory, async () => {
      const checked = await this.repos.checkout(id)
      if (checked.commonDirectory !== commonDirectory)
        throw new ServiceError('repo_changed', 'Repository changed during preparation', 409)
      return run(
        new WorktreeService({
          repoPath: checked.repo.primaryCheckout,
          repoId: checked.repo.id,
          runner: this.runner,
          stateDirectory: this.#stateDirectory,
          ...this.options,
        }),
      )
    })
  }
}
