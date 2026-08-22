import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CommandResult, CommandRunner } from '../preflight/command-runner.js'
import {
  DirtyWorktreeError,
  InvalidPullRequestError,
  WorktreePathConflictError,
  WorktreeService,
  parseRepoId,
} from './service.js'

const execFileAsync = promisify(execFile)
const now = new Date('2026-08-22T00:00:00.000Z')
const dayMs = 24 * 60 * 60 * 1_000

type GitFixture = {
  root: string
  bare: string
  seed: string
  checkout: string
  stateDirectory: string
}

let fixture: GitFixture

describe('WorktreeService', () => {
  beforeEach(async () => {
    fixture = await createGitFixture()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('uses the pinned GitHub PR fetch and detached-add command sequence', async () => {
    const stateDirectory = join(fixture.root, 'recording-state')
    const target = join(stateDirectory, 'worktrees', 'owner', 'repo', 'pr-42')
    const calls: Array<{ args: readonly string[]; cwd: string | undefined }> = []
    const runner: CommandRunner = {
      async run(_command, args, options): Promise<CommandResult> {
        calls.push({ args: [...args], cwd: options.cwd })
        let stdout = ''
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') stdout = fixture.checkout
        if (args[0] === 'remote') stdout = 'git@github.com:owner/repo.git'
        if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') stdout = 'abc123'
        if (args[0] === 'worktree' && args[1] === 'add') await mkdir(target, { recursive: true })
        return { status: 'completed', exitCode: 0, stdout, stderr: '' }
      },
    }
    const service = new WorktreeService({ repoPath: fixture.checkout, stateDirectory, runner })

    await expect(service.prepare(42)).resolves.toEqual({
      path: target,
      headSha: 'abc123',
      reused: false,
    })
    expect(calls.map(({ args }) => args)).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['remote', 'get-url', 'origin'],
      ['worktree', 'prune'],
      ['worktree', 'list', '--porcelain'],
      ['fetch', '--no-tags', 'origin', 'pull/42/head'],
      ['rev-parse', 'FETCH_HEAD'],
      ['worktree', 'add', '--detach', target, 'abc123'],
    ])
    expect(calls.every(({ cwd }) => cwd !== undefined)).toBe(true)
    expect(calls.flatMap(({ args }) => args)).not.toContain('--force')
  })

  it('creates a detached PR worktree outside the checkout and reuses its pinned head', async () => {
    const service = makeService()
    const firstPromise = service.prepare(42)
    expect(service.prepare(42)).toBe(firstPromise)
    const first = await firstPromise

    expect(first).toEqual({
      path: join(fixture.stateDirectory, 'worktrees', 'remote-owner', 'repo', 'pr-42'),
      headSha: await git(fixture.seed, 'rev-parse', 'HEAD'),
      reused: false,
    })
    expect(await git(first.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(first.path.startsWith(`${fixture.checkout}/`)).toBe(false)

    await commitAndPublishPullRef(42, 'second version')
    const reused = await service.prepare(42)

    expect(reused).toEqual({ ...first, reused: true })
    expect(await git(reused.path, 'show', 'HEAD:review.txt')).toBe('first version')
  })

  it('refuses conflicting paths and invalid pull request numbers', async () => {
    const service = makeService()
    const conflict = join(fixture.stateDirectory, 'worktrees', 'remote-owner', 'repo', 'pr-42')
    await mkdir(conflict, { recursive: true })

    await expect(service.prepare(42)).rejects.toBeInstanceOf(WorktreePathConflictError)
    expect(() => service.prepare(0)).toThrow(InvalidPullRequestError)
  })

  it('rejects symlink targets and state directories inside the checkout', async () => {
    const target = join(fixture.stateDirectory, 'worktrees', 'remote-owner', 'repo', 'pr-42')
    await mkdir(dirname(target), { recursive: true })
    await symlink(fixture.checkout, target, 'dir')

    await expect(makeService().prepare(42)).rejects.toBeInstanceOf(WorktreePathConflictError)
    await expect(
      new WorktreeService({
        repoPath: fixture.checkout,
        stateDirectory: join(fixture.checkout, '.state'),
      }).prepare(42),
    ).rejects.toThrow('Worktree root must be outside the repository')
  })

  it('preserves dirty worktrees and removes clean worktrees without force', async () => {
    const service = makeService()
    const prepared = await service.prepare(42)
    const untracked = join(prepared.path, 'local-note.txt')
    await writeFile(untracked, 'keep me')

    await expect(service.remove(42)).rejects.toBeInstanceOf(DirtyWorktreeError)
    await unlink(untracked)
    await expect(service.remove(42)).resolves.toBe(true)
    await expect(service.remove(42)).resolves.toBe(false)
  })

  it('sweeps only expired, registered, clean, inactive worktrees', async () => {
    await publishPullRef(43)
    await publishPullRef(44)
    const service = makeService()
    const active = await service.prepare(42)
    const dirty = await service.prepare(43)
    const fresh = await service.prepare(44)
    const unsafe = join(dirname(active.path), 'pr-99')
    await mkdir(unsafe)
    await writeFile(join(dirty.path, 'local-note.txt'), 'keep me')

    const old = new Date(now.getTime() - 15 * dayMs)
    await Promise.all([
      utimes(active.path, old, old),
      utimes(dirty.path, old, old),
      utimes(unsafe, old, old),
    ])

    const protectedSweep = await service.sweep([active.path])
    expect(protectedSweep.removed).toEqual([])
    expect(protectedSweep.failed).toEqual([])
    expect(protectedSweep.skipped).toEqual(
      expect.arrayContaining([
        { path: active.path, reason: 'active' },
        { path: dirty.path, reason: 'dirty' },
        { path: fresh.path, reason: 'fresh' },
        { path: unsafe, reason: 'unsafe' },
      ]),
    )

    const removalSweep = await service.sweep()
    expect(removalSweep.removed).toEqual([active.path])
    expect(removalSweep.failed).toEqual([])
  })
})

describe('parseRepoId', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['ssh://git@github.example.com/owner/repo.git', 'owner/repo'],
    ['/srv/git/owner/repo.git', 'owner/repo'],
  ])('normalizes %s', (remote, expected) => {
    expect(parseRepoId(remote)).toBe(expected)
  })

  it('rejects identities that cannot produce a safe owner/name path', () => {
    expect(() => parseRepoId('repo.git')).toThrow('Cannot derive repository identity')
    expect(() => parseRepoId('git@example.com:../repo.git')).toThrow('Invalid repository identity')
  })
})

function makeService(): WorktreeService {
  return new WorktreeService({
    repoPath: fixture.checkout,
    stateDirectory: fixture.stateDirectory,
    now: () => now,
  })
}

async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), 'legible-worktree-'))
  const bare = join(root, 'remote-owner', 'repo.git')
  const seed = join(root, 'seed')
  const checkout = join(root, 'checkout')
  const stateDirectory = join(root, 'state')

  await mkdir(dirname(bare), { recursive: true })
  await runGit(root, 'init', '--bare', bare)
  await runGit(root, 'init', seed)
  await runGit(seed, 'config', 'user.name', 'Legible Test')
  await runGit(seed, 'config', 'user.email', 'legible@example.invalid')
  await runGit(seed, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(seed, 'review.txt'), 'first version')
  await runGit(seed, 'add', 'review.txt')
  await runGit(seed, 'commit', '-m', 'initial')
  await runGit(seed, 'remote', 'add', 'origin', bare)
  await runGit(seed, 'push', 'origin', 'HEAD:main')
  await publishPullRefFor({ root, bare, seed, checkout, stateDirectory }, 42)
  await runGit(root, 'clone', '--branch', 'main', bare, checkout)

  return { root, bare, seed, checkout, stateDirectory }
}

async function commitAndPublishPullRef(prNumber: number, contents: string): Promise<void> {
  await writeFile(join(fixture.seed, 'review.txt'), contents)
  await runGit(fixture.seed, 'add', 'review.txt')
  await runGit(fixture.seed, 'commit', '-m', `update PR ${String(prNumber)}`)
  await publishPullRef(prNumber)
}

async function publishPullRef(prNumber: number): Promise<void> {
  await publishPullRefFor(fixture, prNumber)
}

async function publishPullRefFor(target: GitFixture, prNumber: number): Promise<void> {
  await runGit(target.seed, 'push', '--force', 'origin', `HEAD:refs/pull/${String(prNumber)}/head`)
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

async function runGit(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' })
}
