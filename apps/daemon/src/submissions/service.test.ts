import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReviewSession } from '@legible/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GitHubClient, CreateGitHubReview } from '../github/client.js'
import { GitHubClientError } from '../github/client.js'
import { createDaemonServices, type DaemonServices } from '../services.js'
import { SessionMutationQueue } from '../sessions/mutation-queue.js'
import { reviewSession } from '../testing/fixtures.js'
import type { WorktreeService } from '../worktrees/service.js'
import { StaleHeadError, SubmissionService } from './service.js'

const openServices: DaemonServices[] = []

afterEach(async () => {
  await Promise.all(
    openServices.splice(0).map(async (services) => {
      await services.persistence.close()
      await services.chats.close()
    }),
  )
})

describe('SubmissionService', () => {
  it('persists a receipt with a marker before completing worktree cleanup', async () => {
    const created: CreateGitHubReview[] = []
    let removed = 0
    const github: GitHubClient = {
      async getPullHead() {
        return 'b'.repeat(40)
      },
      async createReview(input) {
        created.push(input)
        return {
          id: 91,
          htmlUrl: 'https://github.com/owner/repo/pull/42#pullrequestreview-91',
          body: input.body,
          submittedAt: '2026-08-23T01:00:00.000Z',
        }
      },
      async listReviews() {
        return []
      },
    }
    const { service, services } = await setup(github, async () => {
      removed += 1
      expect(services.sessions.get('session-1')?.submission).toMatchObject({
        status: 'submitted',
        cleanup: { status: 'pending' },
      })
      return true
    })

    const result = await service.submit('session-1', {
      event: 'COMMENT',
      body: 'Summary',
    })

    expect(created[0]).toMatchObject({
      commitId: 'b'.repeat(40),
      event: 'COMMENT',
      body: 'Summary\n\n<!-- legible-review-session:session-1 -->',
    })
    expect(removed).toBe(1)
    expect(result.submission).toMatchObject({
      status: 'submitted',
      githubReviewId: 91,
      cleanup: { status: 'complete' },
    })
  })

  it('retains a successful receipt when agent cleanup fails and never deletes the worktree', async () => {
    const remove = vi.fn(async () => true)
    const createReview = vi.fn(async (input: CreateGitHubReview) => ({
      id: 91,
      htmlUrl: 'https://example.test/review/91',
      body: input.body,
      submittedAt: '',
    }))
    const { service, services } = await setup(
      {
        getPullHead: async () => 'b'.repeat(40),
        createReview,
        listReviews: async () => [],
      },
      remove,
    )
    vi.spyOn(services.chats, 'seal').mockRejectedValue(new Error('Config restoration conflict'))

    const result = await service.submit('session-1', { event: 'COMMENT', body: 'Summary' })

    expect(result.submission).toMatchObject({
      status: 'submitted',
      githubReviewId: 91,
      cleanup: { status: 'failed' },
    })
    expect(createReview).toHaveBeenCalledOnce()
    expect(remove).not.toHaveBeenCalled()
  })

  it('warns on a changed head and submits only after explicit override', async () => {
    let writes = 0
    const github: GitHubClient = {
      async getPullHead() {
        return 'c'.repeat(40)
      },
      async createReview(input) {
        writes += 1
        return {
          id: 1,
          htmlUrl: 'https://example.test/review/1',
          body: input.body,
          submittedAt: '',
        }
      },
      async listReviews() {
        return []
      },
    }
    const { service } = await setup(github)

    await expect(service.submit('session-1', { event: 'APPROVE' })).rejects.toBeInstanceOf(
      StaleHeadError,
    )
    expect(writes).toBe(0)

    const result = await service.submit('session-1', {
      event: 'APPROVE',
      allowStaleHead: true,
    })
    expect(writes).toBe(1)
    expect(result.submission).toMatchObject({ status: 'submitted', staleHead: true })
  })

  it('reconciles an ambiguous write by its hidden marker without posting twice', async () => {
    let writes = 0
    const marker = '<!-- legible-review-session:session-1 -->'
    const github: GitHubClient = {
      async getPullHead() {
        return 'b'.repeat(40)
      },
      async createReview() {
        writes += 1
        throw new GitHubClientError('socket closed')
      },
      async listReviews() {
        return [
          {
            id: 44,
            htmlUrl: 'https://example.test/review/44',
            body: `Summary\n\n${marker}`,
            submittedAt: '2026-08-23T01:00:00.000Z',
          },
        ]
      },
    }
    const { service } = await setup(github)

    const result = await service.submit('session-1', { event: 'COMMENT', body: 'Summary' })

    expect(writes).toBe(1)
    expect(result.submission).toMatchObject({ status: 'submitted', githubReviewId: 44 })
  })
})

async function setup(
  github: GitHubClient,
  remove: () => Promise<boolean> = async () => true,
): Promise<{ service: SubmissionService; services: DaemonServices }> {
  const services = createDaemonServices({
    repoPath: '/repo',
    stateDirectory: await mkdtemp(join(tmpdir(), 'legible-submit-')),
    diffSource: {
      async *read() {
        yield 'diff --git a/example.ts b/example.ts'
        yield '--- a/example.ts'
        yield '+++ b/example.ts'
        yield '@@ -1 +1 @@'
        yield '-before'
        yield '+after'
      },
    },
    githubClient: github,
    now: () => new Date('2026-08-23T00:00:00.000Z'),
  })
  openServices.push(services)
  await services.persistence.restore()
  const session: ReviewSession = reviewSession({
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  })
  services.sessions.add(session)
  const worktrees = { remove } as unknown as WorktreeService
  return {
    services,
    service: new SubmissionService(
      services.sessions,
      services.persistence,
      new SessionMutationQueue(),
      services.comments,
      services.chats,
      worktrees,
      github,
      () => new Date('2026-08-23T00:00:00.000Z'),
    ),
  }
}
