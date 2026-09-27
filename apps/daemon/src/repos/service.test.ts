import { mkdir, readFile, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../testing/deferred.js'
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
  it('unregisters an unused repository without touching its checkout', async () => {
    const f = await setup()
    await f.service.register(f.checkout)
    await f.service.unregister('owner/repo')
    expect(f.service.list()).toEqual([])
    expect(await git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.pull.headSha)
    const restored = new RepositoryService(f.runner, f.events, {
      stateDirectory: f.stateDirectory,
      browseRoot: f.root,
    })
    await restored.restore()
    expect(restored.list()).toEqual([])
  })

  it('refuses unregister while linked worktrees or saved reviews exist', async () => {
    const f = await setup()
    await f.service.register(f.checkout)
    const protectedService = new RepositoryService(f.runner, f.events, {
      stateDirectory: f.stateDirectory,
      browseRoot: f.root,
      sessionCount: () => 1,
    })
    await protectedService.restore()
    await expect(protectedService.unregister('owner/repo')).rejects.toMatchObject({
      code: 'repo_in_use',
    })
    const linked = join(f.root, 'linked')
    await git(f.checkout, 'worktree', 'add', '--detach', linked, 'HEAD')
    await expect(f.service.unregister('owner/repo')).rejects.toMatchObject({
      code: 'repo_worktrees_in_use',
    })
    expect(f.service.list()).toHaveLength(1)
  })

  async function secondCheckout(f: Awaited<ReturnType<typeof setup>>) {
    const second = join(f.root, 'second')
    await git(f.root, 'clone', f.bare, second)
    await git(second, 'remote', 'set-url', 'origin', 'git@github.com:owner/repo.git')
    await f.service.register(f.checkout)
    await f.service.register(second)
    return second
  }

  it('changes an unused primary, forgets registration only, and persists before publishing', async () => {
    const f = await setup()
    const second = await secondCheckout(f)
    expect(await f.service.details('owner/repo')).toMatchObject({
      sessionCount: 0,
      checkouts: [
        { path: f.checkout, available: true },
        { path: second, available: true },
      ],
    })
    const updated = await f.service.setPrimary('owner/repo', second)
    expect(updated.primaryCheckout).toBe(second)
    const forgotten = await f.service.forgetCheckout('owner/repo', f.checkout)
    expect(forgotten.checkouts).toEqual([second])
    expect(await git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.pull.headSha)
    const restored = new RepositoryService(f.runner, f.events, {
      stateDirectory: f.stateDirectory,
      browseRoot: f.root,
    })
    await restored.restore()
    expect(restored.get('owner/repo')).toEqual(forgotten)
    await expect(f.service.forgetCheckout('owner/repo', second)).rejects.toMatchObject({
      code: 'primary_checkout_required',
    })
    await expect(f.service.setPrimary('owner/repo', f.checkout)).rejects.toMatchObject({
      code: 'checkout_not_registered',
    })
  })

  it('blocks primary changes with saved reviews or linked worktrees', async () => {
    const f = await setup()
    const second = await secondCheckout(f)
    const protectedService = new RepositoryService(f.runner, f.events, {
      stateDirectory: f.stateDirectory,
      browseRoot: f.root,
      sessionCount: () => 1,
    })
    await protectedService.restore()
    await expect(protectedService.setPrimary('owner/repo', second)).rejects.toMatchObject({
      code: 'repo_in_use',
    })
    expect((await protectedService.details('owner/repo')).primaryChangeBlocked).toContain(
      'archived',
    )
    const linked = join(f.root, 'linked')
    await git(f.checkout, 'worktree', 'add', '--detach', linked, 'HEAD')
    await expect(f.service.setPrimary('owner/repo', second)).rejects.toMatchObject({
      code: 'repo_worktrees_in_use',
    })
    expect(f.service.get('owner/repo').primaryCheckout).toBe(f.checkout)
    expect(await git(linked, 'rev-parse', 'HEAD')).toBe(f.pull.headSha)
  })

  it('reports invalid paths, revalidates target identity and can forget an unavailable secondary', async () => {
    const f = await setup()
    const second = await secondCheckout(f)
    await git(second, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git')
    await expect(f.service.setPrimary('owner/repo', second)).rejects.toMatchObject({
      code: 'repo_changed',
    })
    expect((await f.service.details('owner/repo')).checkouts[1]).toMatchObject({ available: false })
    await rm(second, { recursive: true })
    expect((await f.service.details('owner/repo')).checkouts[1]).toMatchObject({ available: false })
    await f.service.forgetCheckout('owner/repo', second)
    expect(f.service.get('owner/repo').checkouts).toEqual([f.checkout])
  })

  it('waits for repository operations before rechecking primary dependencies', async () => {
    const f = await setup()
    const second = await secondCheckout(f)
    const waiting = deferred()
    const entered = deferred()
    const running = f.service.withLock(async () => {
      entered.resolve()
      await waiting.promise
      await git(f.checkout, 'worktree', 'add', '--detach', join(f.root, 'prepared'), 'HEAD')
    })
    await entered.promise
    const changed = f.service.setPrimary('owner/repo', second)
    const failure = expect(changed).rejects.toMatchObject({ code: 'repo_worktrees_in_use' })
    waiting.resolve()
    await running
    await failure
    expect(f.service.get('owner/repo').primaryCheckout).toBe(f.checkout)
  })

  it('keeps registry and events unchanged when saving a checkout change fails', async () => {
    const f = await setup()
    const second = await secondCheckout(f)
    await rm(join(f.stateDirectory, 'repos.json'))
    await mkdir(join(f.stateDirectory, 'repos.json'))
    const publish = vi.spyOn(f.events, 'publish')
    await expect(f.service.setPrimary('owner/repo', second)).rejects.toMatchObject({
      code: 'repo_store_failed',
    })
    expect(f.service.get('owner/repo').primaryCheckout).toBe(f.checkout)
    expect(publish).not.toHaveBeenCalled()
    publish.mockRestore()
  })
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
