import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../events/event-bus.js'
import { RepositoryService } from '../repos/service.js'
import { git, repositoryFixture } from '../testing/repository.js'
import { WorktreeManager } from './manager.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function setup(repoId = 'owner/repo') {
  const fixture = await repositoryFixture(repoId)
  roots.push(fixture.root)
  const repos = new RepositoryService(fixture.runner, new EventBus(), {
    stateDirectory: fixture.stateDirectory,
    browseRoot: fixture.root,
  })
  const repo = await repos.register(fixture.checkout)
  const manager = new WorktreeManager(repos, fixture.runner, {
    stateDirectory: fixture.stateDirectory,
  })
  return { ...fixture, repo, repos, manager }
}

describe('WorktreeManager', () => {
  it('prepares pinned detached revisions without changing the checkout or FETCH_HEAD', async () => {
    const f = await setup()
    await writeFile(join(f.checkout, '.git', 'FETCH_HEAD'), 'leave this alone\n')
    const prepared = await f.manager.prepare(f.repo.id, f.pull)
    expect(prepared).toMatchObject({
      headSha: f.pull.headSha,
      baseSha: f.pull.baseSha,
      reused: false,
    })
    expect(await git(prepared.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(await git(f.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature')
    expect(await readFile(join(f.checkout, '.git', 'FETCH_HEAD'), 'utf8')).toBe(
      'leave this alone\n',
    )
    const reused = await f.manager.prepare(f.repo.id, f.pull)
    expect(reused).toEqual({ ...prepared, reused: true })
  })

  it('serializes different PR fetches in one clone and keeps their heads separate', async () => {
    const f = await setup()
    await writeFile(join(f.checkout, 'example.ts'), 'another\n')
    await git(f.checkout, 'commit', '-am', 'other PR')
    const headSha = await git(f.checkout, 'rev-parse', 'HEAD')
    await git(f.checkout, 'push', f.bare, `${headSha}:refs/pull/43/head`)
    const [first, second] = await Promise.all([
      f.manager.prepare(f.repo.id, f.pull),
      f.manager.prepare(f.repo.id, { ...f.pull, number: 43, headSha }),
    ])
    expect(first.headSha).toBe(f.pull.headSha)
    expect(second.headSha).toBe(headSha)
    expect(await git(first.path, 'rev-parse', 'HEAD')).toBe(first.headSha)
    expect(await git(second.path, 'rev-parse', 'HEAD')).toBe(second.headSha)
  })

  it('rejects metadata/fetch races and missing merge-base before adding a worktree', async () => {
    const f = await setup()
    await expect(
      f.manager.prepare(f.repo.id, { ...f.pull, headSha: 'f'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'pr_changed' })
    const original = f.runner.run.bind(f.runner)
    f.runner.run = (command, args, options) =>
      args[0] === 'merge-base'
        ? Promise.resolve({ status: 'completed', exitCode: 1, stdout: '', stderr: '' })
        : original(command, args, options)
    await expect(f.manager.prepare(f.repo.id, f.pull)).rejects.toMatchObject({
      code: 'merge_base_unavailable',
    })
    await expect(access(join(f.stateDirectory, 'worktrees/owner/repo/pr-42'))).rejects.toThrow()
  })

  it('never removes another repository path or a dirty worktree', async () => {
    const f = await setup()
    const prepared = await f.manager.prepare(f.repo.id, f.pull)
    await expect(
      f.manager.remove({ repoId: 'unknown/repo', prNumber: 42, worktreePath: prepared.path }),
    ).rejects.toMatchObject({ code: 'repo_not_found' })
    await expect(
      f.manager.remove({ repoId: f.repo.id, prNumber: 42, worktreePath: f.checkout }),
    ).rejects.toMatchObject({ code: 'worktree_path_conflict' })
    await writeFile(join(prepared.path, 'user.txt'), 'preserve me')
    await expect(
      f.manager.remove({ repoId: f.repo.id, prNumber: 42, worktreePath: prepared.path }),
    ).rejects.toThrow('local changes')
    expect(await readFile(join(prepared.path, 'user.txt'), 'utf8')).toBe('preserve me')
  })
})
