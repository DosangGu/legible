import { rm } from 'node:fs/promises'
import { AgentBackendKind } from '@legible/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonServices, type DaemonServices } from '../services.js'
import { git, repositoryFixture } from '../testing/repository.js'
import { parseCreateSessionRequest } from './open-service.js'

const roots: string[] = []
const servicesToClose: DaemonServices[] = []
afterEach(async () => {
  await Promise.all(
    servicesToClose.splice(0).map(async (services) => {
      await services.persistence.close()
      await services.chats.close()
      await services.mcp.close()
    }),
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
const config = {
  main: { backend: AgentBackendKind.Claude, shell: 'none', network: 'off', onOutOfScope: 'deny' },
} as const
async function setup() {
  const f = await repositoryFixture()
  roots.push(f.root)
  const getPullRequest = vi.fn(async () => f.pull)
  const start = vi.fn(async () => {
    throw new Error('No model should start')
  })
  const options = {
    stateDirectory: f.stateDirectory,
    browseRoot: f.root,
    runner: f.runner,
    pullRequestReader: {
      getPullRequest,
      listPullRequests: vi.fn(async () => ({ items: [f.pull], page: 1, hasNextPage: false })),
    },
    claudeBackend: { start },
    codexBackend: { start },
  }
  const services = createDaemonServices(options)
  servicesToClose.push(services)
  await services.repos.restore()
  await services.persistence.restore()
  await services.preflight.refresh()
  await services.repos.register(f.checkout)
  return { ...f, services, options, getPullRequest, start }
}

describe('OpenReviewService', () => {
  it('coalesces duplicate opens, persists pinned data, and never starts an agent', async () => {
    const f = await setup()
    const request = { repoId: 'owner/repo', prNumber: 42, config }
    const [first, second] = await Promise.all([
      f.services.openReviews.open(request),
      f.services.openReviews.open(request),
    ])
    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.session.id).toBe(first.session.id)
    expect(f.getPullRequest).toHaveBeenCalledOnce()
    expect(f.start).not.toHaveBeenCalled()
    expect(first.session).toMatchObject({
      baseSha: f.pull.baseSha,
      headSha: f.pull.headSha,
      pullRequest: { title: f.pull.title },
    })
    const next = createDaemonServices(f.options)
    servicesToClose.push(next)
    await next.repos.restore()
    await next.persistence.restore()
    expect(next.sessions.get(first.session.id)).toMatchObject(second.session)
    expect(next.repos.list()).toHaveLength(1)
  })

  it('reuses a saved review without changing its configuration or fetching a new head', async () => {
    const f = await setup()
    const first = await f.services.openReviews.open({ repoId: 'owner/repo', prNumber: 42, config })
    f.getPullRequest.mockRejectedValue(new Error('No network'))
    const second = await f.services.openReviews.open({
      repoId: 'owner/repo',
      prNumber: 42,
      config: { main: { ...config.main, backend: AgentBackendKind.Codex } },
    })
    expect(second.session.config).toEqual(config)
    expect(second.session.headSha).toBe(first.session.headSha)
    expect(f.getPullRequest).toHaveBeenCalledOnce()
  })

  it('cleans up only newly created worktrees when saving fails', async () => {
    const f = await setup()
    const save = vi.spyOn(f.services.persistence, 'save').mockRejectedValue(new Error('disk full'))
    const remove = vi.spyOn(f.services.worktrees, 'remove')
    await expect(
      f.services.openReviews.open({ repoId: 'owner/repo', prNumber: 42, config }),
    ).rejects.toMatchObject({ code: 'session_save_failed' })
    expect(remove).toHaveBeenCalledOnce()
    expect(f.services.sessions.list()).toEqual([])
    const previous = await f.services.worktrees.prepare('owner/repo', f.pull)
    await expect(
      f.services.openReviews.open({ repoId: 'owner/repo', prNumber: 42, config }),
    ).rejects.toMatchObject({ code: 'session_save_failed' })
    expect(remove).toHaveBeenCalledOnce()
    expect(await git(previous.path, 'rev-parse', 'HEAD')).toBe(f.pull.headSha)
    save.mockRestore()
  })

  it('permits opening with a missing unused agent but blocks starting that agent', async () => {
    const f = await setup()
    const original = f.runner.run.bind(f.runner)
    f.runner.run = (command, args, options) =>
      command === 'codex'
        ? Promise.resolve({ status: 'missing' })
        : original(command, args, options)
    await f.services.preflight.refresh()
    const opened = await f.services.openReviews.open({
      repoId: 'owner/repo',
      prNumber: 42,
      config: { main: { ...config.main, backend: AgentBackendKind.Codex } },
    })
    expect(() => f.services.chats.startReview(opened.session.id)).toThrow('codex')
    expect(f.services.chats.get(opened.session.id).entries).toEqual([])
    expect(f.start).not.toHaveBeenCalled()
  })

  it('validates configurations while leaving model and effort values backend-native', () => {
    expect(
      parseCreateSessionRequest({
        repoId: 'Owner/Repo',
        prNumber: 42,
        config: { main: { ...config.main, model: 'future-model', effort: 'future-effort' } },
      }).config.main.model,
    ).toBe('future-model')
    expect(() =>
      parseCreateSessionRequest({
        repoId: 'owner/repo',
        prNumber: 42,
        config: { ...config, assist: config.main },
      }),
    ).toThrow()
    expect(() =>
      parseCreateSessionRequest({
        repoId: 'owner/repo',
        prNumber: 42,
        config: { main: { ...config.main, shell: 'broad' } },
      }),
    ).toThrow()
  })
})
