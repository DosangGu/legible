import { homedir } from 'node:os'
import { lstat, mkdir, readdir, realpath, utimes } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ServiceError } from '../common/service-error.js'

import {
  NodeCommandRunner,
  type CommandResult,
  type CommandRunner,
} from '../preflight/command-runner.js'

const gitTimeoutMs = 60_000
const defaultTtlMs = 14 * 24 * 60 * 60 * 1_000
const repoPartPattern = /^[A-Za-z0-9_.-]+$/u
const pullRequestDirectoryPattern = /^pr-([1-9][0-9]*)$/u

export type PreparedWorktree = {
  path: string
  headSha: string
  reused: boolean
}

export type WorktreeSweepSkipReason = 'active' | 'fresh' | 'dirty' | 'unsafe'

export type WorktreeSweepResult = {
  removed: string[]
  skipped: Array<{ path: string; reason: WorktreeSweepSkipReason }>
  failed: Array<{ path: string; message: string }>
}

export type WorktreeServiceOptions = {
  repoPath: string
  runner?: CommandRunner
  stateDirectory?: string
  ttlMs?: number
  now?: () => Date
  repoId?: string
}

type WorktreeContext = {
  repoPath: string
  repoRoot: string
}

type RegisteredWorktree = {
  path: string
  headSha?: string
}

export class InvalidPullRequestError extends Error {
  constructor(prNumber: number) {
    super(`Invalid pull request number: ${String(prNumber)}`)
    this.name = 'InvalidPullRequestError'
  }
}

export class WorktreePathConflictError extends Error {
  constructor(path: string) {
    super(`Worktree path exists but is not a safe registered worktree: ${path}`)
    this.name = 'WorktreePathConflictError'
  }
}

export class DirtyWorktreeError extends Error {
  constructor(path: string) {
    super(`Worktree contains local changes: ${path}`)
    this.name = 'DirtyWorktreeError'
  }
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: CommandResult,
  ) {
    super(`Git command failed: git ${args.join(' ')}`)
    this.name = 'GitCommandError'
  }
}

export class WorktreeService {
  readonly #runner: CommandRunner
  readonly #repoPath: string
  readonly #stateDirectory: string
  readonly #ttlMs: number
  readonly #now: () => Date
  readonly #repoId: string | undefined
  readonly #preparing = new Map<number, Promise<PreparedWorktree>>()

  constructor(options: WorktreeServiceOptions) {
    this.#runner = options.runner ?? new NodeCommandRunner()
    this.#repoPath = resolve(options.repoPath)
    this.#stateDirectory = resolve(options.stateDirectory ?? defaultStateDirectory())
    this.#ttlMs = options.ttlMs ?? defaultTtlMs
    this.#now = options.now ?? (() => new Date())
    this.#repoId = options.repoId ? normalizeRepoId(options.repoId) : undefined

    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs < 0) {
      throw new RangeError('Worktree TTL must be a non-negative finite number')
    }
  }

  prepare(prNumber: number): Promise<PreparedWorktree> {
    assertPullRequestNumber(prNumber)
    const existing = this.#preparing.get(prNumber)
    if (existing) return existing

    const preparing = this.#prepare(prNumber).finally(() => {
      this.#preparing.delete(prNumber)
    })
    this.#preparing.set(prNumber, preparing)
    return preparing
  }

  /** Caller serializes by the clone's common Git directory. Never use shared FETCH_HEAD. */
  async preparePinned(input: {
    number: number
    headSha: string
    baseSha: string
    baseRef: string
  }): Promise<PreparedWorktree & { baseSha: string }> {
    assertPullRequestNumber(input.number)
    if (!/^[a-f0-9]{40,64}$/u.test(input.headSha) || !/^[a-f0-9]{40,64}$/u.test(input.baseSha))
      throw new ServiceError('invalid_revision', 'GitHub returned an invalid revision', 502)
    const context = await this.#context()
    await this.#git(['check-ref-format', `refs/heads/${input.baseRef}`], context.repoPath)
    const target = worktreePath(context.repoRoot, input.number)
    const registered = await this.#registeredWorktrees(context.repoPath)
    const previous = registered.get(target)
    if (!previous && (await pathExists(target))) throw new WorktreePathConflictError(target)
    if (previous) {
      const stats = await safeLstat(target)
      if (!stats?.isDirectory() || stats.isSymbolicLink())
        throw new WorktreePathConflictError(target)
      await this.#assertClean(target)
      const head = await this.#gitStdout(['rev-parse', 'HEAD'], target)
      if (head !== input.headSha)
        throw new ServiceError(
          'pinned_worktree_conflict',
          'An existing worktree has a different pinned head; it will not be reset',
          409,
        )
    }
    const prefix = `refs/legible/pull/${String(input.number)}`
    await this.#git(
      [
        '-c',
        'core.hooksPath=/dev/null',
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `+refs/pull/${String(input.number)}/head:${prefix}/head`,
        `+refs/heads/${input.baseRef}:${prefix}/base`,
      ],
      context.repoPath,
    )
    const head = await this.#gitStdout(['rev-parse', `${prefix}/head`], context.repoPath)
    const base = await this.#gitStdout(['rev-parse', `${prefix}/base`], context.repoPath)
    if (head !== input.headSha || base !== input.baseSha)
      throw new ServiceError(
        'pr_changed',
        'The PR changed while preparing it. Retry to load its current revisions.',
        409,
      )
    let baseSha: string
    try {
      baseSha = await this.#gitStdout(['merge-base', base, head], context.repoPath)
    } catch {
      throw new ServiceError(
        'merge_base_unavailable',
        'Cannot determine merge-base. Fetch the missing Git history in your checkout and retry.',
        409,
      )
    }
    if (!/^[a-f0-9]{40,64}$/u.test(baseSha))
      throw new ServiceError('merge_base_unavailable', 'Git returned an invalid merge-base', 409)
    if (previous) {
      await touch(target, this.#now())
      return { path: target, headSha: head, baseSha, reused: true }
    }
    // Do not execute checkout hooks while materializing PR-controlled content.
    await this.#git(
      ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', target, head],
      context.repoPath,
    )
    return { path: target, headSha: head, baseSha, reused: false }
  }

  async remove(prNumber: number): Promise<boolean> {
    assertPullRequestNumber(prNumber)
    const context = await this.#context()
    const target = worktreePath(context.repoRoot, prNumber)
    await this.#git(['worktree', 'prune'], context.repoPath)
    const registered = await this.#registeredWorktrees(context.repoPath)
    const entry = registered.get(target)

    if (!entry) {
      if (await pathExists(target)) throw new WorktreePathConflictError(target)
      return false
    }

    const stats = await safeLstat(target)
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw new WorktreePathConflictError(target)
    }
    await this.#assertClean(target)
    await this.#git(['worktree', 'remove', target], context.repoPath)
    return true
  }

  async sweep(activePaths: readonly string[] = []): Promise<WorktreeSweepResult> {
    const result: WorktreeSweepResult = { removed: [], skipped: [], failed: [] }
    const context = await this.#context()
    await this.#git(['worktree', 'prune'], context.repoPath)
    const registered = await this.#registeredWorktrees(context.repoPath)
    const active = new Set(activePaths.map((path) => resolve(path)))
    const candidates = await listPullRequestDirectories(context.repoRoot)

    for (const candidate of candidates) {
      if (candidate.isSymbolicLink || !candidate.isDirectory || !registered.has(candidate.path)) {
        result.skipped.push({ path: candidate.path, reason: 'unsafe' })
        continue
      }
      if (active.has(candidate.path)) {
        result.skipped.push({ path: candidate.path, reason: 'active' })
        continue
      }
      if (this.#now().getTime() - candidate.mtimeMs < this.#ttlMs) {
        result.skipped.push({ path: candidate.path, reason: 'fresh' })
        continue
      }

      try {
        if (!(await this.#isClean(candidate.path))) {
          result.skipped.push({ path: candidate.path, reason: 'dirty' })
          continue
        }
        await this.#git(['worktree', 'remove', candidate.path], context.repoPath)
        result.removed.push(candidate.path)
      } catch (error) {
        result.failed.push({ path: candidate.path, message: errorMessage(error) })
      }
    }

    return result
  }

  async #prepare(prNumber: number): Promise<PreparedWorktree> {
    const context = await this.#context()
    const target = worktreePath(context.repoRoot, prNumber)
    await this.#git(['worktree', 'prune'], context.repoPath)
    const registered = await this.#registeredWorktrees(context.repoPath)
    const entry = registered.get(target)

    if (entry) {
      const stats = await safeLstat(target)
      if (!stats?.isDirectory() || stats.isSymbolicLink()) {
        throw new WorktreePathConflictError(target)
      }
      const headSha = await this.#gitStdout(['rev-parse', 'HEAD'], target)
      await touch(target, this.#now())
      return { path: target, headSha, reused: true }
    }

    if (await pathExists(target)) throw new WorktreePathConflictError(target)

    await mkdir(dirname(target), { recursive: true })
    await this.#git(
      ['fetch', '--no-tags', 'origin', `pull/${String(prNumber)}/head`],
      context.repoPath,
    )
    const headSha = await this.#gitStdout(['rev-parse', 'FETCH_HEAD'], context.repoPath)
    await this.#git(['worktree', 'add', '--detach', target, headSha], context.repoPath)
    await touch(target, this.#now())
    return { path: target, headSha, reused: false }
  }

  async #context(): Promise<WorktreeContext> {
    const repoPath = resolve(
      await this.#gitStdout(['rev-parse', '--show-toplevel'], this.#repoPath),
    )
    const canonicalRepoPath = await realpath(repoPath)
    const repoId =
      this.#repoId ?? parseRepoId(await this.#gitStdout(['remote', 'get-url', 'origin'], repoPath))
    const repoRoot = resolve(this.#stateDirectory, 'worktrees', ...repoId.split('/'))

    assertOutsideRepo(canonicalRepoPath, repoRoot)
    await mkdir(repoRoot, { recursive: true })
    const canonicalRepoRoot = await realpath(repoRoot)
    assertOutsideRepo(canonicalRepoPath, canonicalRepoRoot)

    return { repoPath: canonicalRepoPath, repoRoot: canonicalRepoRoot }
  }

  async #registeredWorktrees(repoPath: string): Promise<Map<string, RegisteredWorktree>> {
    const output = await this.#gitStdout(['worktree', 'list', '--porcelain'], repoPath)
    return parseWorktreeList(output)
  }

  async #assertClean(path: string): Promise<void> {
    if (!(await this.#isClean(path))) throw new DirtyWorktreeError(path)
  }

  async #isClean(path: string): Promise<boolean> {
    return (await this.#gitStdout(['status', '--porcelain', '--untracked-files=all'], path)) === ''
  }

  async #git(args: readonly string[], cwd: string): Promise<CommandResult> {
    const result = await this.#runner.run('git', args, { timeoutMs: gitTimeoutMs, cwd })
    if (result.status !== 'completed' || result.exitCode !== 0) {
      throw new GitCommandError(args, result)
    }
    return result
  }

  async #gitStdout(args: readonly string[], cwd: string): Promise<string> {
    const result = await this.#git(args, cwd)
    if (result.status !== 'completed') throw new GitCommandError(args, result)
    return result.stdout.trim()
  }
}

export function parseRepoId(remoteUrl: string): string {
  const value = remoteUrl.trim().replace(/\/+$/u, '')
  let remotePath = value

  if (value.includes('://')) {
    try {
      remotePath = new URL(value).pathname
    } catch {
      throw new Error(`Unsupported origin URL: ${remoteUrl}`)
    }
  } else {
    const scpMatch = /^[^/]+:(.+)$/u.exec(value)
    if (scpMatch?.[1]) remotePath = scpMatch[1]
  }

  const parts = remotePath.split(/[\\/]/u).filter(Boolean)
  const name = parts.at(-1)?.replace(/\.git$/u, '')
  const owner = parts.at(-2)
  if (!owner || !name)
    throw new Error(`Cannot derive repository identity from origin: ${remoteUrl}`)
  return normalizeRepoId(`${owner}/${name}`)
}

function normalizeRepoId(repoId: string): string {
  const parts = repoId.split('/')
  if (
    parts.length !== 2 ||
    parts.some((part) => !repoPartPattern.test(part) || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid repository identity: ${repoId}`)
  }
  return repoId
}

function assertPullRequestNumber(prNumber: number): void {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new InvalidPullRequestError(prNumber)
}

function assertOutsideRepo(repoPath: string, candidate: string): void {
  const pathFromRepo = relative(repoPath, candidate)
  if (pathFromRepo === '' || (!pathFromRepo.startsWith(`..${sep}`) && pathFromRepo !== '..')) {
    throw new Error(`Worktree root must be outside the repository: ${candidate}`)
  }
}

function worktreePath(repoRoot: string, prNumber: number): string {
  const target = resolve(repoRoot, `pr-${String(prNumber)}`)
  if (dirname(target) !== repoRoot || !isAbsolute(target)) {
    throw new Error(`Unsafe worktree path: ${target}`)
  }
  return target
}

function defaultStateDirectory(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME
  return join(
    xdgStateHome && isAbsolute(xdgStateHome) ? xdgStateHome : join(homedir(), '.local', 'state'),
    'legible',
  )
}

function parseWorktreeList(output: string): Map<string, RegisteredWorktree> {
  const worktrees = new Map<string, RegisteredWorktree>()
  for (const block of output.split(/\n\n+/u)) {
    let path: string | undefined
    let headSha: string | undefined
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = resolve(line.slice('worktree '.length))
      if (line.startsWith('HEAD ')) headSha = line.slice('HEAD '.length).trim()
    }
    if (path) worktrees.set(path, { path, ...(headSha ? { headSha } : {}) })
  }
  return worktrees
}

async function listPullRequestDirectories(
  repoRoot: string,
): Promise<
  Array<{ path: string; isDirectory: boolean; isSymbolicLink: boolean; mtimeMs: number }>
> {
  const entries = await readdir(repoRoot, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!pullRequestDirectoryPattern.test(entry.name)) continue
    const path = resolve(repoRoot, entry.name)
    const stats = await lstat(path)
    candidates.push({
      path,
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      mtimeMs: stats.mtimeMs,
    })
  }
  return candidates
}

async function pathExists(path: string): Promise<boolean> {
  return (await safeLstat(path)) !== undefined
}

async function safeLstat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function touch(path: string, date: Date): Promise<void> {
  await utimes(path, date, date)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
