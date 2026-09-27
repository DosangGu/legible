import { rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { createDaemon, type DaemonRuntime } from '../server.js'
import { repositoryFixture } from '../testing/repository.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('requires browser authentication and registers a selected leaf through existing validation', async () => {
  const f = await repositoryFixture()
  cleanups.push(() => rm(f.root, { recursive: true, force: true }))
  const runtime: DaemonRuntime = await createDaemon({
    version: 'test',
    stateDirectory: f.stateDirectory,
    browseRoot: f.root,
    runner: f.runner,
  })
  cleanups.push(() => runtime.app.close())
  const headers = { host: 'localhost', origin: 'http://localhost' }
  expect((await runtime.app.inject({ url: '/api/directories', headers })).statusCode).toBe(401)
  const auth = await runtime.app.inject({
    method: 'POST',
    url: '/api/auth',
    headers,
    payload: { token: runtime.access.bootstrapToken },
  })
  const cookie = String(auth.headers['set-cookie']).split(';')[0]!
  const send = (url: string) => runtime.app.inject({ url, headers: { ...headers, cookie } })
  const root = await send('/api/directories')
  expect(root.statusCode).toBe(200)
  expect(root.json()).toMatchObject({
    path: f.root,
    entries: expect.arrayContaining([{ name: 'checkout', path: f.checkout, repository: true }]),
  })
  expect(
    (await send(`/api/directories?path=${encodeURIComponent(f.checkout)}`)).json(),
  ).toMatchObject({
    repository: true,
    entries: [],
  })
  expect(
    (await send(`/api/directories?path=${encodeURIComponent(`${f.checkout}/.git`)}`)).statusCode,
  ).toBe(403)
  expect((await send('/api/directories?path=relative')).statusCode).toBe(400)
  const registered = await runtime.app.inject({
    method: 'POST',
    url: '/api/repos',
    headers: { ...headers, cookie },
    payload: { path: f.checkout },
  })
  expect(registered.json()).toMatchObject({ id: 'owner/repo', primaryCheckout: f.checkout })
})
