import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InjectOptions, FastifyInstance } from 'fastify'
import { afterEach, expect, it } from 'vitest'
import { createDaemonServices } from '../services.js'
import { git, repositoryFixture } from '../testing/repository.js'
import { reviewSession } from '../testing/fixtures.js'
import { BrowserAccess } from './access.js'
import { buildApp } from './app.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

it('authenticates searches, pins file reads, guards revisions, and keeps non-diff comments forbidden', async () => {
  const f = await repositoryFixture()
  await writeFile(join(f.checkout, 'helper.ts'), 'unchanged needle\n')
  await git(f.checkout, 'add', '.')
  await git(f.checkout, 'commit', '-m', 'helper')
  const headSha = await git(f.checkout, 'rev-parse', 'HEAD')
  const services = createDaemonServices({ stateDirectory: f.stateDirectory, runner: f.runner })
  const session = reviewSession({
    id: 'search-api',
    reviewRevision: 2,
    headSha,
    baseSha: headSha,
    worktreePath: f.checkout,
  })
  services.sessions.add(session)
  const access = new BrowserAccess()
  const app = await buildApp({ services, access, version: 'test' })
  cleanup.push(async () => {
    await app.close()
    await rm(f.root, { recursive: true, force: true })
  })
  const path = '/api/sessions/search-api'
  expect(
    (await app.inject({ url: `${path}/search?q=needle`, headers: { host: 'localhost' } }))
      .statusCode,
  ).toBe(401)
  const auth = await app.inject({
    method: 'POST',
    url: '/api/auth',
    headers: { host: 'localhost', origin: 'http://localhost' },
    payload: { token: access.bootstrapToken },
  })
  const cookie = String(auth.headers['set-cookie']).split(';')[0]!
  const request = (options: InjectOptions) => inject(app, cookie, options)
  expect((await request({ url: `${path}/search?q=needle` })).statusCode).toBe(409)
  const headers = { 'x-legible-review-revision': '2' }
  const found = await request({ url: `${path}/search?q=needle`, headers })
  expect(found.statusCode).toBe(200)
  expect(found.json()).toMatchObject({
    reviewRevision: 2,
    matches: [{ path: 'helper.ts', line: 1 }],
  })
  const opened = await request({ url: `${path}/search/file?path=helper.ts`, headers })
  expect(opened.statusCode).toBe(200)
  expect(opened.json()).toMatchObject({
    content: 'unchanged needle\n',
    sha: headSha,
    side: 'RIGHT',
  })
  expect(
    (await request({ url: `${path}/file?path=helper.ts&side=RIGHT`, headers })).statusCode,
  ).toBe(404)
  expect(
    (
      await request({
        method: 'POST',
        url: `${path}/comments`,
        headers,
        payload: { path: 'helper.ts', line: 1, side: 'RIGHT', body: 'not in diff' },
      })
    ).statusCode,
  ).toBe(400)
  expect((await request({ url: `${path}/search`, headers })).statusCode).toBe(400)
  expect(
    (await request({ url: `${path}/search/file?path=..%2Foutside`, headers })).statusCode,
  ).toBe(400)
  services.sessions.replace({ ...session, reviewRevision: 3 })
  expect((await request({ url: `${path}/search?q=needle`, headers })).statusCode).toBe(409)
  expect((await request({ url: `${path}/search/file?path=helper.ts`, headers })).statusCode).toBe(
    409,
  )
})

function inject(app: FastifyInstance, cookie: string, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: { host: 'localhost', origin: 'http://localhost', cookie, ...options.headers },
  })
}
