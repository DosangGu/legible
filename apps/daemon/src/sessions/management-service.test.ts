import { mkdtemp, rm } from 'node:fs/promises'
import { AgentBackendKind } from '@legible/protocol'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonServices, type DaemonServices } from '../services.js'
import { reviewSession } from '../testing/fixtures.js'
import { deferred } from '../testing/deferred.js'
import { SessionStore } from './store.js'

const roots: string[] = []
const instances: DaemonServices[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const services of instances.splice(0)) {
    await services.persistence.close()
    await services.chats.close()
    await services.mcp.close()
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup() {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'legible-management-'))
  roots.push(stateDirectory)
  const start = vi.fn(async () => {
    throw new Error('No model calls expected')
  })
  const services = createDaemonServices({ stateDirectory, claudeBackend: { start } })
  instances.push(services)
  const session = reviewSession({
    config: {
      main: {
        backend: AgentBackendKind.Claude,
        shell: 'none',
        network: 'off',
        onOutOfScope: 'deny',
      },
    },
    reviewRevision: 2,
  })
  services.sessions.add(session)
  services.chats.restore(session.id, {
    snapshot: {
      sessionId: session.id,
      revision: 1,
      status: 'idle',
      backend: session.config.main.backend,
      entries: [
        {
          id: 'message',
          turnId: 'turn',
          createdAt: session.createdAt,
          kind: 'message',
          role: 'assistant',
          text: 'Saved conversation',
        },
      ],
    },
  })
  await services.persistence.flush(session.id)
  return { services, session, stateDirectory, start }
}

describe('Review visibility management', () => {
  it('persists archive state and conversation across restart, then reopens the same pinned session', async () => {
    const f = await setup()
    const archived = await f.services.sessionManagement.archive(f.session.id, true)
    expect(archived.archivedAt).toBeTruthy()
    expect(archived).toMatchObject(f.session)
    expect(() => f.services.chats.send(f.session.id, 'Do not run')).toThrow('Restore')
    const records = await new SessionStore(f.stateDirectory).loadAll()
    expect(records[0]?.session).toEqual(archived)
    expect(records[0]?.chat?.snapshot.entries).toHaveLength(1)
    await f.services.persistence.close()
    const second = createDaemonServices({
      stateDirectory: f.stateDirectory,
      claudeBackend: { start: f.start },
    })
    instances.push(second)
    await second.persistence.restore()
    expect(second.sessions.get(f.session.id)).toEqual(archived)
    const opened = await second.openReviews.open({
      repoId: f.session.repoId,
      prNumber: f.session.prNumber,
      config: f.session.config,
    })
    expect(opened.reused).toBe(true)
    expect(opened.session).toMatchObject(f.session)
    expect(opened.session.archivedAt).toBeUndefined()
    expect(opened.session.lastOpenedAt).toBeTruthy()
    expect(second.chats.get(f.session.id).entries).toHaveLength(1)
    expect(f.start).not.toHaveBeenCalled()
  })

  it('blocks archiving active agents and reviews being refreshed', async () => {
    const f = await setup()
    const busy = vi.spyOn(f.services.chats, 'isBusy').mockReturnValue(true)
    await expect(f.services.sessionManagement.archive(f.session.id, true)).rejects.toMatchObject({
      code: 'review_busy',
    })
    busy.mockRestore()
    const release = f.services.sessions.beginRefresh(f.session.id)
    await expect(f.services.sessionManagement.archive(f.session.id, true)).rejects.toMatchObject({
      code: 'review_refreshing',
    })
    release()
    expect(f.services.sessions.get(f.session.id)).toEqual(f.session)
  })

  it.each(['submitting', 'uncertain', 'pending', 'failed'] as const)(
    'blocks unresolved submission or cleanup: %s',
    async (status) => {
      const f = await setup()
      const common = {
        event: 'APPROVE' as const,
        marker: 'marker',
        startedAt: f.session.createdAt,
        currentHeadSha: f.session.headSha,
        staleHead: false,
      }
      f.services.sessions.replace({
        ...f.session,
        submission:
          status === 'submitting' || status === 'uncertain'
            ? { ...common, status }
            : {
                ...common,
                status: 'submitted',
                githubReviewId: 1,
                htmlUrl: 'https://github.com/owner/repo/pull/42',
                submittedAt: f.session.createdAt,
                cleanup: { status },
              },
      })
      await expect(f.services.sessionManagement.archive(f.session.id, true)).rejects.toMatchObject({
        code: 'review_locked',
      })
      expect(f.services.sessions.get(f.session.id)?.archivedAt).toBeUndefined()
    },
  )

  it('blocks archive during submission preflight, before submission state is saved', async () => {
    const f = await setup()
    const waiting = deferred()
    const entered = deferred()
    const services = createDaemonServices({
      stateDirectory: join(f.stateDirectory, 'submission'),
      githubClient: {
        getPullHead: async () => {
          entered.resolve()
          await waiting.promise
          throw new Error('preflight failed')
        },
        createReview: vi.fn(),
        listReviews: vi.fn(),
      },
    })
    instances.push(services)
    services.sessions.add(f.session)
    const submitting = services.submissions.submit(f.session.id, { event: 'APPROVE' })
    const failed = expect(submitting).rejects.toThrow('preflight failed')
    await entered.promise
    await expect(services.sessionManagement.archive(f.session.id, true)).rejects.toMatchObject({
      code: 'review_busy',
    })
    waiting.resolve()
    await failed
  })

  it('prevents new turns during archive persistence and leaves state unchanged on save failure', async () => {
    const f = await setup()
    const waiting = deferred()
    const entered = deferred()
    vi.spyOn(f.services.persistence, 'save').mockImplementation(async () => {
      entered.resolve()
      await waiting.promise
      throw new Error('disk full')
    })
    const archive = f.services.sessionManagement.archive(f.session.id, true)
    const failure = expect(archive).rejects.toMatchObject({ code: 'session_save_failed' })
    await entered.promise
    expect(() => f.services.chats.send(f.session.id, 'Do not run')).toThrow('being updated')
    expect(f.services.sessions.get(f.session.id)).toEqual(f.session)
    waiting.resolve()
    await failure
    expect(() => f.services.sessions.assertMutable(f.session.id)).not.toThrow()
    expect(
      (await new SessionStore(f.stateDirectory).loadAll())[0]?.session.archivedAt,
    ).toBeUndefined()
  })

  it('restores without losing submission receipts or previous review history', async () => {
    const f = await setup()
    const submission = {
      status: 'submitted' as const,
      event: 'APPROVE' as const,
      marker: 'marker',
      startedAt: f.session.createdAt,
      currentHeadSha: f.session.headSha,
      staleHead: false,
      githubReviewId: 1,
      htmlUrl: 'https://github.com/owner/repo/pull/42',
      submittedAt: f.session.createdAt,
      cleanup: { status: 'complete' as const },
    }
    const session = {
      ...f.session,
      submission,
      submissionHistory: [
        { reviewRevision: 0, headSha: 'old', baseSha: 'base', comments: [], submission },
      ],
    }
    f.services.sessions.replace(session)
    await f.services.sessionManagement.archive(session.id, true)
    expect(await f.services.sessionManagement.archive(session.id, false)).toEqual(session)
  })
})
