import { lstat, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { Repo } from '@legible/protocol'
import * as z from 'zod/v4'

import { ServiceError } from '../common/service-error.js'
import { defaultStateDirectory, writeState } from '../common/state.js'
import type { EventBus } from '../events/event-bus.js'
import type { CommandRunner } from '../preflight/command-runner.js'
import { SessionMutationQueue } from '../sessions/mutation-queue.js'

const repoSchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  checkouts: z.array(z.string()).min(1),
  primaryCheckout: z.string(),
})

export class RepositoryService {
  readonly #repos = new Map<string, Repo>()
  readonly #queue = new SessionMutationQueue()
  readonly #path: string
  readonly #root: string

  constructor(
    private readonly runner: CommandRunner,
    private readonly events: EventBus,
    options: { stateDirectory?: string; browseRoot?: string } = {},
  ) {
    this.#path = join(options.stateDirectory ?? defaultStateDirectory(), 'repos.json')
    this.#root = resolve(options.browseRoot ?? process.env.LEGIBLE_BROWSE_ROOT ?? homedir())
  }

  async restore(): Promise<void> {
    let content: string
    try {
      content = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return
      throw new ServiceError('repo_store_failed', 'Unable to read the repository registry', 500)
    }
    try {
      const data = z
        .object({ version: z.literal(1), repos: z.array(repoSchema) })
        .parse(JSON.parse(content))
      for (const repo of data.repos) {
        if (
          repo.id !== `${repo.owner}/${repo.name}` ||
          normalizeRepoId(repo.id) !== repo.id ||
          !repo.checkouts.includes(repo.primaryCheckout) ||
          repo.checkouts.some((path) => !isAbsolute(path)) ||
          this.#repos.has(repo.id)
        )
          throw new Error('Invalid registry')
        this.#repos.set(repo.id, repo)
      }
    } catch {
      throw new ServiceError(
        'repo_store_failed',
        'Invalid repository registry; restore repos.json from a backup',
        500,
      )
    }
  }

  list(): Repo[] {
    return structuredClone([...this.#repos.values()])
  }

  get(id: string): Repo {
    const repo = this.#repos.get(normalizeRepoId(id))
    if (!repo)
      throw new ServiceError('repo_not_found', 'Register this repository checkout first', 404)
    return structuredClone(repo)
  }

  register(path: string): Promise<Repo> {
    return this.#queue.run('registry', async () => {
      const inspected = await this.#inspect(path)
      const existing = this.#repos.get(inspected.id)
      const repo: Repo = existing
        ? { ...existing, checkouts: [...new Set([...existing.checkouts, inspected.path])] }
        : {
            id: inspected.id,
            owner: inspected.owner,
            name: inspected.name,
            checkouts: [inspected.path],
            primaryCheckout: inspected.path,
          }
      const next = new Map(this.#repos).set(repo.id, repo)
      try {
        await writeState(this.#path, { version: 1, repos: [...next.values()] })
      } catch {
        throw new ServiceError('repo_store_failed', 'Unable to save the repository registry', 500)
      }
      this.#repos.set(repo.id, repo)
      this.events.publish({ type: 'repo.updated', payload: structuredClone(repo) })
      return structuredClone(repo)
    })
  }

  /** Revalidate filesystem and origin immediately before operations on a registered clone. */
  async checkout(id: string): Promise<{ repo: Repo; commonDirectory: string }> {
    const repo = this.get(id)
    const inspected = await this.#inspect(repo.primaryCheckout)
    if (inspected.path !== repo.primaryCheckout || inspected.id !== repo.id) {
      throw new ServiceError(
        'repo_changed',
        'The registered checkout or its origin changed; restore the original checkout',
        409,
      )
    }
    const commonDirectory = await realpath(
      resolve(inspected.path, await this.#git(inspected.path, ['rev-parse', '--git-common-dir'])),
    )
    return { repo, commonDirectory }
  }

  async #inspect(
    input: string,
  ): Promise<{ id: string; owner: string; name: string; path: string }> {
    if (!input || !isAbsolute(input) || input.includes('\0'))
      throw new ServiceError('invalid_repo_path', 'Enter an absolute repository path')
    let root: string
    let path: string
    try {
      root = await realpath(this.#root)
      path = await realpath(input)
    } catch {
      throw new ServiceError(
        'repo_path_unavailable',
        'Repository path or configured browse root is unavailable',
        404,
      )
    }
    assertWithin(root, path)
    const top = await this.#git(path, ['rev-parse', '--show-toplevel'])
    path = await realpath(top)
    assertWithin(root, path)
    const marker = await lstat(join(path, '.git')).catch(() => undefined)
    if (!marker?.isDirectory() || marker.isSymbolicLink())
      throw new ServiceError(
        'unsupported_checkout',
        'Register a regular clone, not a bare repository or linked worktree',
      )
    const id = githubRepoId(await this.#git(path, ['remote', 'get-url', 'origin']))
    const [owner, name] = id.split('/') as [string, string]
    return { id, owner, name, path }
  }

  async #git(cwd: string, args: string[]): Promise<string> {
    const result = await this.runner.run('git', args, { cwd, timeoutMs: 10_000 })
    if (result.status !== 'completed' || result.exitCode !== 0)
      throw new ServiceError(
        'invalid_repository',
        'Unable to inspect this Git checkout and its origin',
        409,
      )
    return result.stdout.trim()
  }
}

export function normalizeRepoId(id: string): string {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(id) ||
    id.split('/').some((part) => part === '.' || part === '..')
  )
    throw new ServiceError('invalid_repo_id', 'Invalid GitHub repository identifier')
  return id.toLowerCase()
}

export function githubRepoId(remote: string): string {
  let path: string | undefined
  const scp = /^git@github\.com:([^?#\s]+)$/iu.exec(remote)
  if (scp) path = scp[1]
  else {
    try {
      const url = new URL(remote)
      if (
        url.hostname.toLowerCase() === 'github.com' &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !url.port &&
        ((url.protocol === 'https:' && !url.username) ||
          (url.protocol === 'ssh:' && url.username === 'git'))
      )
        path = url.pathname.replace(/^\//u, '')
    } catch {
      /* not a supported remote */
    }
  }
  if (!path)
    throw new ServiceError(
      'unsupported_origin',
      'Only GitHub.com HTTPS or git@github.com SSH origins are supported',
    )
  return normalizeRepoId(path.replace(/\.git$/iu, ''))
}

function assertWithin(root: string, path: string): void {
  const part = relative(root, path)
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new ServiceError(
      'repo_path_forbidden',
      'Repository must be under LEGIBLE_BROWSE_ROOT (defaults to your home directory)',
      403,
    )
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
