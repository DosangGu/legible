import { rm, writeFile, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentBackendKind } from '@legible/protocol'
import type { CreateGitHubReview } from '../github/client.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonServices, type DaemonServices } from '../services.js'
import { git, repositoryFixture } from '../testing/repository.js'
import { SessionStore } from './store.js'
import { buildApp } from '../api/app.js'
import { BrowserAccess } from '../api/access.js'

const roots: string[] = []
const open: DaemonServices[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const services of open.splice(0)) {
    await services.chats.close()
    await services.persistence.close()
    await services.mcp.close()
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const f = await repositoryFixture()
  roots.push(f.root)
  const start = vi.fn(async () => {
    throw new Error('No automatic model calls')
  })
  const writes: CreateGitHubReview[] = []
  const services = createDaemonServices({
    stateDirectory: f.stateDirectory,
    browseRoot: f.root,
    runner: f.runner,
    pullRequestReader: {
      getPullRequest: async () => ({ ...f.pull }),
      listPullRequests: async () => ({ items: [], page: 1, hasNextPage: false }),
    },
    claudeBackend: { start },
    codexBackend: { start },
    githubClient: {
      getPullHead: async () => f.pull.headSha,
      listReviews: async () => [],
      createReview: async (input) => {
        writes.push(input)
        return {
          id: writes.length,
          htmlUrl: `https://example.test/${String(writes.length)}`,
          body: input.body,
          submittedAt: '2026-09-19T00:00:00Z',
        }
      },
    },
  })
  open.push(services)
  await services.repos.restore()
  await services.preflight.refresh()
  await services.repos.register(f.checkout)
  const { session } = await services.openReviews.open({
    repoId: 'owner/repo',
    prNumber: 42,
    config: {
      main: {
        backend: AgentBackendKind.Claude,
        shell: 'none',
        network: 'off',
        onOutOfScope: 'deny',
      },
    },
  })
  const advance = async (content = 'new content\n') => {
    await writeFile(join(f.checkout, 'example.ts'), content)
    await git(f.checkout, 'commit', '-am', 'advance')
    f.pull.headSha = await git(f.checkout, 'rev-parse', 'HEAD')
    await git(f.checkout, 'push', f.bare, 'HEAD:refs/pull/42/head')
  }
  const guarded = <T>(revision: number, operation: () => T) =>
    services.sessions.withRevision(session.id, revision, operation)
  return { ...f, services, session, start, advance, guarded, writes }
}

describe('same-session review refresh', () => {
  it('maps an exact rename on RIGHT, retains LEFT anchors, and blocks deleted paths', async () => {
    const f = await setup()
    const right = await f.services.comments.create(f.session.id, {
      path: 'example.ts',
      side: 'RIGHT',
      line: 1,
      body: 'right',
    })
    const left = await f.services.comments.create(f.session.id, {
      path: 'example.ts',
      side: 'LEFT',
      line: 1,
      body: 'left',
    })
    await git(f.checkout, 'mv', 'example.ts', 'renamed.ts')
    await git(f.checkout, 'commit', '-m', 'rename')
    f.pull.headSha = await git(f.checkout, 'rev-parse', 'HEAD')
    await git(f.checkout, 'push', f.bare, 'HEAD:refs/pull/42/head')
    const result = await f.services.refreshReviews.refresh(f.session.id)
    expect(result.session.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: right.id, path: 'renamed.ts', anchorStatus: 'current' }),
        expect.objectContaining({ id: left.id, path: 'example.ts', anchorStatus: 'current' }),
      ]),
    )
    await git(f.checkout, 'rm', 'renamed.ts')
    await git(f.checkout, 'commit', '-m', 'delete')
    f.pull.headSha = await git(f.checkout, 'rev-parse', 'HEAD')
    await git(f.checkout, 'push', f.bare, 'HEAD:refs/pull/42/head')
    const removed = await f.services.refreshReviews.refresh(f.session.id)
    expect(removed.session.comments.find((comment) => comment.id === right.id)?.anchorStatus).toBe(
      'needs_review',
    )
  })

  it('preserves the old review if configuration restoration fails', async () => {
    const f = await setup()
    await f.advance()
    vi.spyOn(f.services.chats, 'prepareRefresh').mockRejectedValue(
      new Error('Configuration restoration conflict'),
    )
    const save = vi.spyOn(f.services.persistence, 'saveRevision')
    await expect(f.services.refreshReviews.refresh(f.session.id)).rejects.toMatchObject({
      code: 'review_agent_cleanup_failed',
    })
    expect(save).not.toHaveBeenCalled()
    expect(f.services.sessions.get(f.session.id)).toEqual(f.session)
    expect(await git(f.session.worktreePath, 'rev-parse', 'HEAD')).toBe(f.session.headSha)
  })
  it('keeps drafts and chat, marks changed anchors pending, persists v3 and blocks stale mutations', async () => {
    const f = await setup()
    const comment = await f.services.comments.create(f.session.id, {
      path: 'example.ts',
      side: 'RIGHT',
      line: 1,
      body: 'Investigate',
    })
    const oldChat = f.services.chats.get(f.session.id)
    oldChat.entries.push({
      id: 'message',
      turnId: 'turn',
      kind: 'message',
      role: 'user',
      text: 'Prior discussion',
      createdAt: '',
    })
    f.services.chats.restore(f.session.id, { snapshot: oldChat, retry: { kind: 'review' } })
    await f.advance()
    expect(await f.services.refreshReviews.check(f.session.id)).toMatchObject({
      headChanged: true,
      baseChanged: false,
    })
    const result = await f.guarded(0, () => f.services.refreshReviews.refresh(f.session.id))
    expect(result.session).toMatchObject({
      id: f.session.id,
      reviewRevision: 1,
      headSha: f.pull.headSha,
      comments: [{ id: comment.id, anchorStatus: 'needs_review', anchorRevision: 0 }],
    })
    expect(result.session.worktreePath).not.toBe(f.session.worktreePath)
    await expect(access(f.session.worktreePath)).rejects.toThrow()
    expect(f.services.chats.get(f.session.id)).toMatchObject({
      reviewPending: true,
      status: 'idle',
      entries: [{ text: 'Prior discussion' }, { kind: 'notice' }],
    })
    expect(f.services.chats.exportState(f.session.id)?.retry).toBeUndefined()
    expect(f.start).not.toHaveBeenCalled()
    await expect(
      f.guarded(0, () => f.services.comments.remove(f.session.id, comment.id)),
    ).rejects.toMatchObject({ code: 'stale_review_revision' })
    await expect(
      f.guarded(1, () => f.services.submissions.submit(f.session.id, { event: 'APPROVE' })),
    ).rejects.toThrow('Reconnect')
    const anchored = await f.guarded(1, () =>
      f.services.comments.reanchor(f.session.id, comment.id, {
        path: 'example.ts',
        side: 'RIGHT',
        line: 1,
        body: 'ignored',
      }),
    )
    expect(anchored).toMatchObject({
      id: comment.id,
      body: 'Investigate',
      anchorStatus: 'current',
      anchorRevision: 1,
    })
    const stored = (await new SessionStore(f.stateDirectory).loadAll())[0]!
    expect(stored.version).toBe(3)
    expect(stored.chat?.snapshot.entries[0]).toMatchObject({ text: 'Prior discussion' })
    expect(stored.session.comments[0]?.anchorStatus).toBe('current')
  })

  it('rolls back failed atomic persistence and removes only the candidate generation', async () => {
    const f = await setup()
    await f.services.persistence.flush(f.session.id)
    const before = await readFile(new SessionStore(f.stateDirectory).pathFor(f.session.id), 'utf8')
    const events: unknown[] = []
    f.services.eventBus.subscribe((event) => events.push(event))
    const remove = vi.spyOn(f.services.worktrees, 'remove')
    vi.spyOn(f.services.persistence, 'saveRevision').mockRejectedValue(new Error('disk full'))
    await f.advance()
    await expect(f.services.refreshReviews.refresh(f.session.id)).rejects.toMatchObject({
      code: 'review_refresh_save_failed',
    })
    expect(f.services.sessions.get(f.session.id)).toEqual(f.session)
    expect(await readFile(new SessionStore(f.stateDirectory).pathFor(f.session.id), 'utf8')).toBe(
      before,
    )
    expect(remove).toHaveBeenCalledOnce()
    expect(remove.mock.calls[0]![0].worktreePath).not.toBe(f.session.worktreePath)
    expect(await git(f.session.worktreePath, 'rev-parse', 'HEAD')).toBe(f.session.headSha)
    expect(events).toEqual([])
  })

  it('no-ops an unchanged effective diff and records base-tip movement without losing drafts', async () => {
    const f = await setup()
    await git(f.checkout, 'checkout', 'main')
    await writeFile(join(f.checkout, 'base-only.ts'), 'base advancement\n')
    await git(f.checkout, 'add', '.')
    await git(f.checkout, 'commit', '-m', 'base advance')
    f.pull.baseSha = await git(f.checkout, 'rev-parse', 'HEAD')
    await git(f.checkout, 'push', f.bare, 'HEAD:refs/heads/main')
    expect(await f.services.refreshReviews.check(f.session.id)).toMatchObject({
      baseChanged: true,
      headChanged: false,
    })
    const result = await f.services.refreshReviews.refresh(f.session.id)
    expect(result.changed).toBe(false)
    expect(result.session).toMatchObject({
      reviewRevision: 0,
      worktreePath: f.session.worktreePath,
      baseTipSha: f.pull.baseSha,
      baseSha: f.session.baseSha,
    })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('archives submissions, reopens the same revision into a fresh draft, and uses a distinct marker', async () => {
    const f = await setup()
    const comment = await f.services.comments.create(f.session.id, {
      path: 'example.ts',
      side: 'RIGHT',
      line: 1,
      body: 'First review',
    })
    await f.services.submissions.submit(f.session.id, { event: 'APPROVE' })
    const refreshed = await f.services.refreshReviews.refresh(f.session.id)
    expect(refreshed.session).toMatchObject({
      id: f.session.id,
      reviewRevision: 1,
      comments: [],
      submissionHistory: [
        {
          headSha: f.session.headSha,
          comments: [{ id: comment.id }],
          submission: { status: 'submitted' },
        },
      ],
    })
    expect(refreshed.session.submission).toBeUndefined()
    expect(() =>
      f.services.chats.send(f.session.id, 'Change this submitted comment', comment.id),
    ).toThrow('Draft comment chat item not found')
    await f.guarded(1, () => f.services.submissions.submit(f.session.id, { event: 'APPROVE' }))
    expect(f.writes[1]?.comments).toEqual([])
    expect(f.writes[1]?.body).not.toBe(f.writes[0]?.body)
    const again = await f.services.refreshReviews.refresh(f.session.id)
    expect(again.session.submissionHistory).toHaveLength(2)
    expect(f.start).not.toHaveBeenCalled()
  })

  it('rejects busy agents and unresolved submissions before preparing worktrees', async () => {
    const f = await setup()
    const prepare = vi.spyOn(f.services.worktrees, 'prepare')
    const busy = vi.spyOn(f.services.chats, 'isBusy').mockReturnValue(true)
    await expect(f.services.refreshReviews.refresh(f.session.id)).rejects.toMatchObject({
      code: 'review_busy',
    })
    busy.mockRestore()
    f.services.sessions.replace({
      ...f.session,
      submission: {
        status: 'uncertain',
        event: 'APPROVE',
        marker: 'old-marker',
        currentHeadSha: f.session.headSha,
        startedAt: '',
        staleHead: false,
      },
    })
    await expect(f.services.refreshReviews.refresh(f.session.id)).rejects.toMatchObject({
      code: 'review_locked',
    })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('commits a refresh even if old-worktree cleanup fails, and gates writes during preparation', async () => {
    const f = await setup()
    await f.advance()
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = f.services.worktrees.prepare.bind(f.services.worktrees)
    vi.spyOn(f.services.worktrees, 'prepare').mockImplementation(async (...args) => {
      await wait
      return original(...args)
    })
    vi.spyOn(f.services.worktrees, 'remove').mockRejectedValue(new Error('dirty'))
    const refreshing = f.services.refreshReviews.refresh(f.session.id)
    await vi.waitFor(() => expect(f.services.worktrees.prepare).toHaveBeenCalled())
    expect(() => f.services.chats.send(f.session.id, 'Race')).toThrow('being updated')
    release()
    const result = await refreshing
    expect(result.warning).toContain('old worktree')
    expect(f.services.sessions.get(f.session.id)?.reviewRevision).toBe(1)
    expect(await git(f.session.worktreePath, 'rev-parse', 'HEAD')).toBe(f.session.headSha)
  })

  it('enforces HTTP revision headers on reads, refresh, reanchor, and mutations', async () => {
    const f = await setup()
    const access = new BrowserAccess()
    const app = await buildApp({ services: f.services, access, version: 'test' })
    try {
      const auth = await app.inject({
        method: 'POST',
        url: '/api/auth',
        headers: { host: 'localhost:7777', origin: 'http://localhost:7777' },
        payload: { token: access.bootstrapToken },
      })
      const cookie = String(auth.headers['set-cookie']).split(';')[0]!
      const headers = { cookie, host: 'localhost:7777', origin: 'http://localhost:7777' }
      await f.advance()
      const path = `/api/sessions/${f.session.id}`
      expect(
        (await app.inject({ method: 'POST', url: `${path}/refresh`, headers })).statusCode,
      ).toBe(200)
      for (const suffix of ['diff', 'chat', 'comments']) {
        expect((await app.inject({ url: `${path}/${suffix}`, headers })).statusCode).toBe(409)
        expect(
          (
            await app.inject({
              url: `${path}/${suffix}`,
              headers: { ...headers, 'x-legible-review-revision': '1' },
            })
          ).statusCode,
        ).toBe(200)
      }
      expect(
        (await app.inject({ method: 'POST', url: `${path}/refresh`, headers })).statusCode,
      ).toBe(409)
      expect((await app.inject({ url: path, headers })).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})
