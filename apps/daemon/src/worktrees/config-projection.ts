import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ReviewSession } from '@legible/protocol'

import {
  NodeCommandRunner,
  type CommandResult,
  type CommandRunner,
} from '../preflight/command-runner.js'

const gitTimeoutMs = 10_000
const revisionPattern = /^[0-9a-f]{40,64}$/u
const safeIdPattern = /^[A-Za-z0-9_-]+$/u

export const protectedAgentConfigPaths = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
] as const

type ProtectedAgentConfigPath = (typeof protectedAgentConfigPaths)[number]

type GitFileState = { kind: 'absent' } | { kind: 'file'; oid: string; mode: '100644' | '100755' }

type ProjectionFile = {
  path: ProtectedAgentConfigPath
  base: GitFileState
  head: GitFileState
}

type ProjectionManifest = {
  version: 1
  status: 'preparing' | 'active'
  sessionId: string
  worktreePath: string
  baseSha: string
  headSha: string
  files: ProjectionFile[]
}

type ActiveProjection = {
  manifest: ProjectionManifest
  leases: number
}

export type ConfigProjectionChange = {
  path: ProtectedAgentConfigPath
  action: 'replaced' | 'removed' | 'created'
}

export type ConfigProjectionLease = {
  changes: readonly ConfigProjectionChange[]
  release(): Promise<void>
}

export type ConfigProjectionRecoveryReport = {
  recovered: Array<{ sessionId: string; worktreePath: string; paths: string[] }>
  conflicts: Array<{ sessionId: string; worktreePath: string; paths: string[] }>
  failed: Array<{ manifestPath: string; message: string }>
}

export type WorktreeConfigProjectionOptions = {
  runner?: CommandRunner
  stateDirectory?: string
}

export class ConfigProjectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConfigProjectionError'
  }
}

export class WorktreeConfigProjection {
  readonly #runner: CommandRunner
  readonly #directory: string
  readonly #active = new Map<string, ActiveProjection>()
  readonly #operations = new Map<string, Promise<void>>()

  constructor(options: WorktreeConfigProjectionOptions = {}) {
    this.#runner = options.runner ?? new NodeCommandRunner()
    this.#directory = join(
      resolve(options.stateDirectory ?? defaultStateDirectory()),
      'config-projections',
    )
  }

  acquire(
    session: Pick<ReviewSession, 'id' | 'worktreePath' | 'baseSha' | 'headSha'>,
  ): Promise<ConfigProjectionLease> {
    return this.#locked(resolve(session.worktreePath), async () => {
      validateSession(session)
      const worktreePath = resolve(session.worktreePath)
      const active = this.#active.get(worktreePath)
      if (active) {
        if (active.leases === 0) {
          throw new ConfigProjectionError(
            'A previous config projection could not be restored; restart after resolving the conflict',
          )
        }
        if (!sameProjection(active.manifest, session)) {
          throw new ConfigProjectionError('A different config projection is already active')
        }
        active.leases += 1
        return this.#lease(worktreePath, changesFor(active.manifest.files))
      }

      const stale = await this.#manifestsForWorktree(worktreePath)
      if (stale.length > 0) {
        for (const entry of stale) {
          const restored = await this.#restore(entry.manifest)
          if (restored.length > 0) {
            throw new ConfigProjectionError(
              `Protected config contains unexpected changes: ${restored.join(', ')}`,
            )
          }
          await this.#removeManifest(entry.path)
        }
      }

      await this.#verifyWorktree(session)
      const files = await this.#projectionFiles(session)
      if (files.length === 0) return this.#lease(worktreePath, [])

      const manifest: ProjectionManifest = {
        version: 1,
        status: 'preparing',
        sessionId: session.id,
        worktreePath,
        baseSha: session.baseSha,
        headSha: session.headSha,
        files,
      }
      await this.#writeManifest(manifest)
      try {
        for (const file of files) await this.#materialize(worktreePath, file.path, file.base)
        manifest.status = 'active'
        await this.#writeManifest(manifest)
      } catch (error) {
        const conflicts = await this.#restore(manifest).catch(() => files.map(({ path }) => path))
        if (conflicts.length === 0) await this.#removeManifest(this.#manifestPath(session.id))
        throw new ConfigProjectionError('Unable to project base agent configuration', {
          cause: error,
        })
      }

      this.#active.set(worktreePath, { manifest, leases: 1 })
      return this.#lease(worktreePath, changesFor(files))
    })
  }

  async recover(): Promise<ConfigProjectionRecoveryReport> {
    const report: ConfigProjectionRecoveryReport = { recovered: [], conflicts: [], failed: [] }
    for (const path of await this.#manifestPaths()) {
      try {
        const manifest = await this.#readManifest(path)
        const conflicts = await this.#locked(manifest.worktreePath, () => this.#restore(manifest))
        if (conflicts.length > 0) {
          report.conflicts.push({
            sessionId: manifest.sessionId,
            worktreePath: manifest.worktreePath,
            paths: conflicts,
          })
          continue
        }
        await this.#removeManifest(path)
        report.recovered.push({
          sessionId: manifest.sessionId,
          worktreePath: manifest.worktreePath,
          paths: manifest.files.map(({ path: filePath }) => filePath),
        })
      } catch (error) {
        report.failed.push({ manifestPath: path, message: errorMessage(error) })
      }
    }
    return report
  }

  #lease(worktreePath: string, changes: ConfigProjectionChange[]): ConfigProjectionLease {
    let released = false
    return {
      changes,
      release: async () => {
        if (released) return
        released = true
        await this.#release(worktreePath)
      },
    }
  }

  #release(worktreePath: string): Promise<void> {
    return this.#locked(worktreePath, async () => {
      const active = this.#active.get(worktreePath)
      if (!active) return
      active.leases -= 1
      if (active.leases > 0) return

      const conflicts = await this.#restore(active.manifest)
      if (conflicts.length > 0) {
        throw new ConfigProjectionError(
          `Protected config changed while projected: ${conflicts.join(', ')}`,
        )
      }
      await this.#removeManifest(this.#manifestPath(active.manifest.sessionId))
      this.#active.delete(worktreePath)
    })
  }

  async #verifyWorktree(
    session: Pick<ReviewSession, 'worktreePath' | 'baseSha' | 'headSha'>,
  ): Promise<void> {
    const root = resolve(session.worktreePath)
    const rootStats = await lstat(root).catch(() => undefined)
    if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
      throw new ConfigProjectionError('Review worktree is not a safe directory')
    }
    if ((await realpath(root)) !== root) {
      throw new ConfigProjectionError('Review worktree path must be canonical')
    }
    const head = await this.#gitStdout(['rev-parse', 'HEAD'], root)
    if (head !== session.headSha) throw new ConfigProjectionError('Review worktree HEAD changed')

    const status = await this.#gitStdout(
      ['status', '--porcelain', '--untracked-files=all', '--', ...protectedAgentConfigPaths],
      root,
    )
    if (status) throw new ConfigProjectionError('Protected agent configuration is dirty')
  }

  async #projectionFiles(
    session: Pick<ReviewSession, 'worktreePath' | 'baseSha' | 'headSha'>,
  ): Promise<ProjectionFile[]> {
    const files: ProjectionFile[] = []
    for (const path of protectedAgentConfigPaths) {
      const [base, head] = await Promise.all([
        this.#gitState(session.worktreePath, session.baseSha, path),
        this.#gitState(session.worktreePath, session.headSha, path),
      ])
      if (!sameFileState(base, head)) files.push({ path, base, head })
    }
    return files
  }

  async #gitState(
    cwd: string,
    revision: string,
    path: ProtectedAgentConfigPath,
  ): Promise<GitFileState> {
    const output = await this.#gitStdout(['ls-tree', revision, '--', path], cwd)
    if (!output) return { kind: 'absent' }
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t/u.exec(output)
    if (!match?.[1] || !match[2]) {
      throw new ConfigProjectionError(`Protected config is not a regular file: ${path}`)
    }
    return { kind: 'file', mode: match[1] as '100644' | '100755', oid: match[2] }
  }

  async #restore(manifest: ProjectionManifest): Promise<string[]> {
    await this.#verifyRecoveryWorktree(manifest)
    const conflicts: string[] = []
    for (const file of manifest.files) {
      const current = await this.#workingState(manifest.worktreePath, file.path)
      if (sameFileState(current, file.head)) continue
      if (!sameFileState(current, file.base)) {
        conflicts.push(file.path)
        continue
      }
      await this.#materialize(manifest.worktreePath, file.path, file.head)
    }
    return conflicts
  }

  async #verifyRecoveryWorktree(manifest: ProjectionManifest): Promise<void> {
    const rootStats = await lstat(manifest.worktreePath).catch(() => undefined)
    if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
      throw new ConfigProjectionError('Projected worktree is not a safe directory')
    }
    if ((await realpath(manifest.worktreePath)) !== manifest.worktreePath) {
      throw new ConfigProjectionError('Projected worktree path is no longer canonical')
    }
    const head = await this.#gitStdout(['rev-parse', 'HEAD'], manifest.worktreePath)
    if (head !== manifest.headSha) {
      throw new ConfigProjectionError('Projected worktree HEAD changed before recovery')
    }
  }

  async #workingState(worktreePath: string, path: ProtectedAgentConfigPath): Promise<GitFileState> {
    await assertSafeParents(worktreePath, path)
    const target = resolve(worktreePath, path)
    const stats = await lstat(target).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stats) return { kind: 'absent' }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ConfigProjectionError(`Protected config is not a regular file: ${path}`)
    }
    const oid = await this.#gitStdout(['hash-object', '--no-filters', path], worktreePath)
    return { kind: 'file', oid, mode: stats.mode & 0o111 ? '100755' : '100644' }
  }

  async #materialize(
    worktreePath: string,
    path: ProtectedAgentConfigPath,
    state: GitFileState,
  ): Promise<void> {
    await assertSafeParents(worktreePath, path)
    const target = resolveWithin(worktreePath, path)
    if (state.kind === 'absent') {
      await unlink(target).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error
      })
      return
    }

    const content = await this.#gitStdout(['cat-file', 'blob', state.oid], worktreePath, false)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await assertSafeParents(worktreePath, path)
    await writeFileAtomic(target, content, state.mode === '100755' ? 0o755 : 0o644)
  }

  async #manifestsForWorktree(
    worktreePath: string,
  ): Promise<Array<{ path: string; manifest: ProjectionManifest }>> {
    const matches = []
    for (const path of await this.#manifestPaths()) {
      const manifest = await this.#readManifest(path)
      if (manifest.worktreePath === worktreePath) matches.push({ path, manifest })
    }
    return matches
  }

  async #manifestPaths(): Promise<string[]> {
    await ensurePrivateDirectory(this.#directory)
    return (await readdir(this.#directory))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(this.#directory, name))
  }

  async #readManifest(path: string): Promise<ProjectionManifest> {
    try {
      return validateManifest(JSON.parse(await readFile(path, 'utf8')), path)
    } catch (error) {
      if (error instanceof ConfigProjectionError) throw error
      throw new ConfigProjectionError(`Unable to load config projection manifest: ${path}`, {
        cause: error,
      })
    }
  }

  async #writeManifest(manifest: ProjectionManifest): Promise<void> {
    await ensurePrivateDirectory(this.#directory)
    const target = this.#manifestPath(manifest.sessionId)
    await writeFileAtomic(target, `${JSON.stringify(manifest, null, 2)}\n`, 0o600)
  }

  async #removeManifest(path: string): Promise<void> {
    await unlink(path).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    })
  }

  #manifestPath(sessionId: string): string {
    if (!safeIdPattern.test(sessionId)) throw new ConfigProjectionError('Invalid session id')
    return join(this.#directory, `${sessionId}.json`)
  }

  #locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tracked = result.then(
      () => undefined,
      () => undefined,
    )
    this.#operations.set(key, tracked)
    void tracked.then(() => {
      if (this.#operations.get(key) === tracked) this.#operations.delete(key)
    })
    return result
  }

  async #gitStdout(args: readonly string[], cwd: string, trim = true): Promise<string> {
    const result = await this.#runner.run('git', args, { timeoutMs: gitTimeoutMs, cwd })
    if (result.status !== 'completed' || result.exitCode !== 0) throw gitError(args, result)
    return trim ? result.stdout.trim() : result.stdout
  }
}

function changesFor(files: ProjectionFile[]): ConfigProjectionChange[] {
  return files.map((file) => ({
    path: file.path,
    action:
      file.base.kind === 'absent'
        ? 'removed'
        : file.head.kind === 'absent'
          ? 'created'
          : 'replaced',
  }))
}

function sameProjection(
  manifest: ProjectionManifest,
  session: Pick<ReviewSession, 'id' | 'worktreePath' | 'baseSha' | 'headSha'>,
): boolean {
  return (
    manifest.sessionId === session.id &&
    manifest.worktreePath === resolve(session.worktreePath) &&
    manifest.baseSha === session.baseSha &&
    manifest.headSha === session.headSha
  )
}

function sameFileState(left: GitFileState, right: GitFileState): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'absent' ||
      (right.kind === 'file' && left.oid === right.oid && left.mode === right.mode))
  )
}

function validateSession(
  session: Pick<ReviewSession, 'id' | 'worktreePath' | 'baseSha' | 'headSha'>,
): void {
  if (!safeIdPattern.test(session.id)) throw new ConfigProjectionError('Invalid session id')
  if (!revisionPattern.test(session.baseSha) || !revisionPattern.test(session.headSha)) {
    throw new ConfigProjectionError('Invalid review revisions')
  }
  if (!isAbsolute(session.worktreePath)) {
    throw new ConfigProjectionError('Review worktree path must be absolute')
  }
}

function validateManifest(value: unknown, path: string): ProjectionManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.status !== 'preparing' && value.status !== 'active') ||
    typeof value.sessionId !== 'string' ||
    !safeIdPattern.test(value.sessionId) ||
    typeof value.worktreePath !== 'string' ||
    !isAbsolute(value.worktreePath) ||
    typeof value.baseSha !== 'string' ||
    !revisionPattern.test(value.baseSha) ||
    typeof value.headSha !== 'string' ||
    !revisionPattern.test(value.headSha) ||
    !Array.isArray(value.files) ||
    !value.files.every(isProjectionFile)
  ) {
    throw new ConfigProjectionError(`Invalid config projection manifest: ${path}`)
  }
  return value as ProjectionManifest
}

function isProjectionFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    protectedAgentConfigPaths.includes(value.path as ProtectedAgentConfigPath) &&
    isGitFileState(value.base) &&
    isGitFileState(value.head)
  )
}

function isGitFileState(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === 'absent' ||
      (value.kind === 'file' &&
        typeof value.oid === 'string' &&
        revisionPattern.test(value.oid) &&
        (value.mode === '100644' || value.mode === '100755')))
  )
}

async function assertSafeParents(
  worktreePath: string,
  path: ProtectedAgentConfigPath,
): Promise<void> {
  const root = resolve(worktreePath)
  resolveWithin(root, path)
  let current = root
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part)
    const stats = await lstat(current).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stats) return
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ConfigProjectionError(`Unsafe protected config parent: ${path}`)
    }
  }
}

function resolveWithin(root: string, path: ProtectedAgentConfigPath): string {
  const target = resolve(root, path)
  const fromRoot = relative(root, target)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ConfigProjectionError(`Protected config escapes worktree: ${path}`)
  }
  return target
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    await chmod(temporary, mode)
    await rename(temporary, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function gitError(args: readonly string[], result: CommandResult): ConfigProjectionError {
  return new ConfigProjectionError(
    `Git command failed while projecting config: git ${args.join(' ')}`,
    {
      cause: result,
    },
  )
}

function defaultStateDirectory(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME
  return join(
    xdgStateHome && isAbsolute(xdgStateHome) ? xdgStateHome : join(homedir(), '.local', 'state'),
    'legible',
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
