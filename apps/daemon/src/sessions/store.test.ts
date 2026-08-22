import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { reviewSession } from '../testing/fixtures.js'
import { SessionStore, SessionStoreError } from './store.js'

describe('SessionStore', () => {
  it('atomically round-trips a versioned session using private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legible-store-'))
    const store = new SessionStore(root)
    const session = reviewSession()

    await store.save({ version: 1, session })

    await expect(store.loadAll()).resolves.toEqual([{ version: 1, session }])
    expect((await stat(dirname(store.pathFor(session.id)))).mode & 0o777).toBe(0o700)
    expect((await stat(store.pathFor(session.id))).mode & 0o777).toBe(0o600)
  })

  it('fails fast with the offending path for corrupt and unsupported records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legible-store-'))
    const store = new SessionStore(root)
    await store.save({ version: 1, session: reviewSession() })
    await writeFile(store.pathFor('session-1'), '{"version":2}\n', 'utf8')

    await expect(store.loadAll()).rejects.toThrow(SessionStoreError)
    await expect(store.loadAll()).rejects.toThrow(store.pathFor('session-1'))
  })
})
