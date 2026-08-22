import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { DiffSource } from '../diffs/source.js'
import { createDaemonServices, type DaemonServices } from '../services.js'
import { SessionStore } from '../sessions/store.js'
import { reviewSession } from '../testing/fixtures.js'
import { InvalidCommentError } from './service.js'

const servicesToClose: DaemonServices[] = []

afterEach(async () => {
  await Promise.all(
    servicesToClose.splice(0).map(async (services) => {
      await services.persistence.close()
      await services.chats.close()
    }),
  )
})

describe('CommentService', () => {
  it('creates a normalized multi-line draft, persists edits, and removes it', async () => {
    const { services, stateDirectory } = await setup()

    const created = await services.comments.create('session-1', {
      path: 'a.ts',
      line: 2,
      side: 'RIGHT',
      startLine: 3,
      startSide: 'RIGHT',
      body: 'Check this range',
    })

    expect(created).toMatchObject({
      line: 3,
      startLine: 2,
      startSide: 'RIGHT',
      origin: 'human',
    })
    expect((await new SessionStore(stateDirectory).loadAll())[0]?.session.comments).toEqual([
      created,
    ])

    await services.comments.update('session-1', created.id, { body: 'Updated' })
    expect(services.comments.list('session-1')[0]?.body).toBe('Updated')
    await services.comments.remove('session-1', created.id)
    expect(services.comments.list('session-1')).toEqual([])
  })

  it('rejects cross-hunk ranges and serializes concurrent additions without lost updates', async () => {
    const { services } = await setup()

    await expect(
      services.comments.create('session-1', {
        path: 'a.ts',
        line: 10,
        side: 'RIGHT',
        startLine: 2,
        startSide: 'RIGHT',
        body: 'Crosses a gap',
      }),
    ).rejects.toBeInstanceOf(InvalidCommentError)

    await Promise.all([
      services.comments.create('session-1', {
        path: 'a.ts',
        line: 2,
        side: 'LEFT',
        body: 'Left',
      }),
      services.comments.create('session-1', {
        path: 'a.ts',
        line: 2,
        side: 'RIGHT',
        body: 'Right',
      }),
    ])
    expect(services.comments.list('session-1').map((comment) => comment.body)).toEqual([
      'Left',
      'Right',
    ])
  })
})

async function setup() {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'legible-comments-'))
  const services = createDaemonServices({
    repoPath: '/repo',
    stateDirectory,
    diffSource: source(),
    now: () => new Date('2026-08-22T00:00:00.000Z'),
  })
  servicesToClose.push(services)
  await services.persistence.restore()
  services.sessions.add(reviewSession({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }))
  return { services, stateDirectory }
}

function source(): DiffSource {
  return {
    async *read() {
      yield 'diff --git a/a.ts b/a.ts'
      yield '--- a/a.ts'
      yield '+++ b/a.ts'
      yield '@@ -1,3 +1,3 @@'
      yield ' one'
      yield '-before'
      yield '+after'
      yield ' three'
      yield '@@ -10 +10 @@'
      yield '-old'
      yield '+new'
    },
  }
}
