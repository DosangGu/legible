import { mkdir, readFile, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../events/event-bus.js'
import { git, repositoryFixture } from '../testing/repository.js'
import { githubRepoId, RepositoryService } from './service.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const fixture = await repositoryFixture('Owner/Repo')
  roots.push(fixture.root)
  const events = new EventBus()
  const service = new RepositoryService(fixture.runner, events, {
    stateDirectory: fixture.stateDirectory,
    browseRoot: fixture.root,
  })
  return { ...fixture, service, events }
}

describe('RepositoryService', () => {
  it('normalizes aliases, deduplicates checkouts and persists before publishing', async () => {
    const f = await setup()
    await mkdir(join(f.checkout, 'nested'))
    await symlink(f.checkout, join(f.root, 'alias'))
    const repo = await f.service.register(join(f.checkout, 'nested'))
    await f.service.register(join(f.root, 'alias'))
    expect(repo).toMatchObject({
      id: 'owner/repo',
      primaryCheckout: f.checkout,
      checkouts: [f.checkout],
    })
    expect(f.service.list()).toEqual([repo])
    const stored = JSON.parse(await readFile(join(f.stateDirectory, 'repos.json'), 'utf8')) as {
      repos: unknown[]
    }
    expect(stored.repos).toEqual([repo])
    expect((await stat(join(f.stateDirectory, 'repos.json'))).mode & 0o777).toBe(0o600)
    const restored = new RepositoryService(f.runner, f.events, {
      stateDirectory: f.stateDirectory,
      browseRoot: f.root,
    })
    await restored.restore()
    expect(restored.list()).toEqual([repo])
  })

  it('retains the first primary checkout when another clone is registered', async () => {
    const f = await setup()
    await f.service.register(f.checkout)
    const second = join(f.root, 'second')
    await git(f.root, 'clone', f.bare, second)
    await git(second, 'remote', 'set-url', 'origin', 'git@github.com:owner/repo.git')
    const repo = await f.service.register(second)
    expect(repo.primaryCheckout).toBe(f.checkout)
    expect(repo.checkouts).toEqual([f.checkout, second])
  })

  it('rejects root escapes, outside symlinks, relative paths and linked worktrees', async () => {
    const f = await setup()
    const restricted = new RepositoryService(f.runner, f.events, {
      stateDirectory: f.stateDirectory,
      browseRoot: f.checkout,
    })
    await symlink(f.root, join(f.checkout, 'escape'))
    await expect(restricted.register(join(f.checkout, '..'))).rejects.toMatchObject({
      code: 'repo_path_forbidden',
    })
    await expect(restricted.register(join(f.checkout, 'escape'))).rejects.toMatchObject({
      code: 'repo_path_forbidden',
    })
    await expect(f.service.register('checkout')).rejects.toMatchObject({
      code: 'invalid_repo_path',
    })
    await git(f.checkout, 'worktree', 'add', '--detach', join(f.root, 'linked'), 'HEAD')
    await expect(f.service.register(join(f.root, 'linked'))).rejects.toMatchObject({
      code: 'unsupported_checkout',
    })
    await expect(f.service.register(f.bare)).rejects.toMatchObject({ code: 'invalid_repository' })
  })

  it('refuses a missing primary checkout or changed origin without switching clones', async () => {
    const f = await setup()
    await f.service.register(f.checkout)
    await git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git')
    await expect(f.service.checkout('owner/repo')).rejects.toMatchObject({ code: 'repo_changed' })
    await rm(f.checkout, { recursive: true })
    await expect(f.service.checkout('owner/repo')).rejects.toMatchObject({
      code: 'repo_path_unavailable',
    })
    expect(f.service.list()).toHaveLength(1)
  })

  it.each([
    'https://example.test/owner/repo.git',
    '/tmp/owner/repo',
    'https://secret@github.com/owner/repo',
    'ssh://git@evil.test/owner/repo',
    'git@github.com:../repo.git',
  ])('rejects unsupported origin %s', (remote) => {
    expect(() => githubRepoId(remote)).toThrow()
  })
})
