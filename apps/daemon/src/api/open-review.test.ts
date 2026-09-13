import { access, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentBackendKind } from '@legible/protocol'
import type { InjectOptions } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemon, startDaemon, type DaemonRuntime } from '../server.js'
import { git, repositoryFixture } from '../testing/repository.js'
import { NodeCommandRunner, type CommandRunner } from '../preflight/command-runner.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const headers = { host: 'localhost', origin: 'http://localhost' }
const config = {
  main: { backend: AgentBackendKind.Claude, shell: 'none', network: 'off', onOutOfScope: 'deny' },
} as const

async function client(runtime: DaemonRuntime) {
  const auth = await runtime.app.inject({
    method: 'POST',
    url: '/api/auth',
    headers,
    payload: { token: runtime.access.bootstrapToken },
  })
  const cookie = String(auth.headers['set-cookie']).split(';')[0]!
  return (options: InjectOptions) =>
    runtime.app.inject({ ...options, headers: { ...headers, cookie, ...options.headers } })
}

describe('Review entry API', () => {
  it('registers, lists PRs, opens and restores a review without model calls', async () => {
    const f = await repositoryFixture()
    cleanups.push(() => rm(f.root, { recursive: true, force: true }))
    const start = vi.fn(async () => {
      throw new Error('Unexpected model call')
    })
    const listPullRequests = vi.fn(async (_owner: string, _repo: string, page: number) => ({
      page,
      items: [f.pull],
      hasNextPage: page === 1,
    }))
    const options = {
      version: 'test',
      stateDirectory: f.stateDirectory,
      browseRoot: f.root,
      runner: f.runner,
      claudeBackend: { start },
      pullRequestReader: { listPullRequests, getPullRequest: vi.fn(async () => f.pull) },
    }
    const runtime = await createDaemon(options)
    cleanups.push(() => runtime.app.close())
    const send = await client(runtime)
    expect((await send({ url: '/api/repos' })).json()).toEqual([])
    expect(
      (await send({ method: 'POST', url: '/api/repos', payload: { path: f.checkout } })).statusCode,
    ).toBe(201)
    const pulls = await send({ url: '/api/repos/owner/repo/pulls?page=2' })
    expect(pulls.json()).toMatchObject({ page: 2, hasNextPage: false, items: [{ number: 42 }] })
    expect(listPullRequests).toHaveBeenCalledWith('owner', 'repo', 2)
    expect((await send({ url: '/api/repos/owner/repo/pulls?page=0' })).statusCode).toBe(400)
    const opened = await send({
      method: 'POST',
      url: '/api/sessions',
      payload: { repoId: 'owner/repo', prNumber: 42, config },
    })
    expect(opened.statusCode).toBe(201)
    const result = opened.json<{ session: { id: string; headSha: string } }>()
    expect(result.session.headSha).toBe(f.pull.headSha)
    expect((await send({ url: `/api/sessions/${result.session.id}/diff` })).json()).toMatchObject({
      additions: 1,
      deletions: 1,
    })
    expect(start).not.toHaveBeenCalled()
    await runtime.app.close()
    const restarted = await createDaemon(options)
    cleanups.push(() => restarted.app.close())
    const afterRestart = await client(restarted)
    expect((await afterRestart({ url: '/api/repos' })).json()).toHaveLength(1)
    expect((await afterRestart({ url: '/api/sessions' })).json()).toHaveLength(1)
    expect(
      (
        await afterRestart({
          method: 'POST',
          url: '/api/sessions',
          payload: { repoId: 'owner/repo', prNumber: 42, config },
        })
      ).json(),
    ).toMatchObject({ reused: true, session: { id: result.session.id } })
  })

  it('isolates equal PR numbers across repositories and cleans only the submitted one', async () => {
    const first = await repositoryFixture('owner/first')
    cleanups.push(() => rm(first.root, { recursive: true, force: true }))
    const second = await repositoryFixture('owner/second', first.root)
    const node = new NodeCommandRunner()
    const runner: CommandRunner = {
      run: (command, args, options) => {
        if (command !== 'git')
          return Promise.resolve({ status: 'completed', exitCode: 0, stdout: 'ready', stderr: '' })
        return node.run(
          command,
          args.includes('fetch')
            ? args.map((arg) =>
                arg === 'origin'
                  ? options.cwd === first.checkout
                    ? first.bare
                    : second.bare
                  : arg,
              )
            : args,
          options,
        )
      },
    }
    const github = {
      getPullHead: vi.fn(async () => first.pull.headSha),
      createReview: vi.fn(async () => ({
        id: 1,
        htmlUrl: 'https://github.com/owner/first/pull/42#review-1',
        body: '',
        submittedAt: '',
      })),
      listReviews: vi.fn(async () => []),
    }
    const runtime = await createDaemon({
      version: 'test',
      runner,
      browseRoot: first.root,
      stateDirectory: first.stateDirectory,
      pullRequestReader: {
        getPullRequest: async (_owner, repo) => (repo === 'first' ? first.pull : second.pull),
        listPullRequests: async () => ({ page: 1, items: [], hasNextPage: false }),
      },
      githubClient: github,
    })
    cleanups.push(() => runtime.app.close())
    await runtime.services.repos.register(first.checkout)
    await runtime.services.repos.register(second.checkout)
    const [a, b] = await Promise.all(
      ['first', 'second'].map((name) =>
        runtime.services.openReviews.open({ repoId: `owner/${name}`, prNumber: 42, config }),
      ),
    )
    expect(a!.session.worktreePath).not.toBe(b!.session.worktreePath)
    await runtime.services.submissions.submit(a!.session.id, { event: 'APPROVE' })
    await expect(access(a!.session.worktreePath)).rejects.toThrow()
    expect(await git(b!.session.worktreePath, 'rev-parse', 'HEAD')).toBe(second.pull.headSha)
    expect(github.createReview).toHaveBeenCalledOnce()
    expect(
      (await runtime.services.openReviews.open({ repoId: 'owner/first', prNumber: 42, config }))
        .session.submission?.status,
    ).toBe('submitted')
  })

  it('serves SPA routes and only public built assets, and rejects non-loopback binding', async () => {
    const f = await repositoryFixture()
    cleanups.push(() => rm(f.root, { recursive: true, force: true }))
    const webDirectory = join(f.root, 'web')
    await mkdir(join(webDirectory, 'assets'), { recursive: true })
    await writeFile(
      join(webDirectory, 'index.html'),
      '<!doctype html><title>Legible fixture</title>',
    )
    await writeFile(join(webDirectory, 'assets', 'app.js'), 'export {}')
    await writeFile(join(f.root, 'private.js'), 'private')
    await symlink(join(f.root, 'private.js'), join(webDirectory, 'assets', 'escape.js'))
    const runtime = await createDaemon({
      version: 'test',
      stateDirectory: f.stateDirectory,
      runner: f.runner,
      webDirectory,
    })
    cleanups.push(() => runtime.app.close())
    for (const url of ['/', '/repos/owner/repo', '/review/id'])
      expect((await runtime.app.inject({ url, headers })).body).toContain('Legible fixture')
    expect(
      (await runtime.app.inject({ url: '/assets/app.js', headers })).headers['content-type'],
    ).toContain('text/javascript')
    expect((await runtime.app.inject({ url: '/assets/escape.js', headers })).statusCode).toBe(404)
    expect(
      (await runtime.app.inject({ url: '/assets/%2e%2e/private.js', headers })).statusCode,
    ).toBe(404)
    expect((await runtime.app.inject({ url: '/api/sessions', headers })).statusCode).toBe(401)
    await expect(startDaemon({ version: 'test', host: '0.0.0.0' })).rejects.toThrow('loopback')
  })
})
