import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ConfigProjectionError,
  WorktreeConfigProjection,
  protectedAgentConfigPaths,
} from './config-projection.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('WorktreeConfigProjection', () => {
  it('projects changed, added, and removed config from base and restores head on release', async () => {
    const fixture = await createFixture()
    const service = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })

    const lease = await service.acquire(review(fixture))

    expect(lease.changes).toEqual([
      { path: '.claude/settings.json', action: 'replaced' },
      { path: '.claude/settings.local.json', action: 'created' },
      { path: '.mcp.json', action: 'removed' },
    ])
    await expect(readFile(join(fixture.repo, '.claude/settings.json'), 'utf8')).resolves.toBe(
      '{"source":"base"}\n',
    )
    await expect(readFile(join(fixture.repo, '.claude/settings.local.json'), 'utf8')).resolves.toBe(
      '{"local":"base"}\n',
    )
    await expect(lstat(join(fixture.repo, '.mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const manifestDirectory = join(fixture.stateDirectory, 'config-projections')
    expect((await stat(manifestDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(manifestDirectory, 'session-1.json'))).mode & 0o777).toBe(0o600)

    await lease.release()
    await lease.release()

    await expect(readFile(join(fixture.repo, '.claude/settings.json'), 'utf8')).resolves.toBe(
      '{"source":"head"}\n',
    )
    await expect(lstat(join(fixture.repo, '.claude/settings.local.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(join(fixture.repo, '.mcp.json'), 'utf8')).resolves.toBe(
      '{"server":"head"}\n',
    )
    expect(await git(fixture.repo, 'status', '--porcelain')).toBe('')
    expect(await readdir(manifestDirectory)).toEqual([])
  })

  it('keeps a shared projection until its final lease is released', async () => {
    const fixture = await createFixture()
    const service = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })

    const first = await service.acquire(review(fixture))
    const second = await service.acquire(review(fixture))

    await first.release()
    expect(await readFile(join(fixture.repo, '.claude/settings.json'), 'utf8')).toContain('base')
    await second.release()
    expect(await readFile(join(fixture.repo, '.claude/settings.json'), 'utf8')).toContain('head')
  })

  it('does not create a manifest when protected config is unchanged', async () => {
    const fixture = await createFixture()
    await git(fixture.repo, 'reset', '--hard', fixture.baseSha)
    await writeFile(join(fixture.repo, 'README.md'), 'unrelated\n')
    await git(fixture.repo, 'add', 'README.md')
    await git(fixture.repo, 'commit', '-m', 'unrelated')
    fixture.headSha = await git(fixture.repo, 'rev-parse', 'HEAD')
    const service = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })

    const lease = await service.acquire(review(fixture))

    expect(lease.changes).toEqual([])
    expect(await readdir(join(fixture.stateDirectory, 'config-projections'))).toEqual([])
    await lease.release()
  })

  it('recovers an active projection after a daemon crash', async () => {
    const fixture = await createFixture()
    const crashed = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })
    await crashed.acquire(review(fixture))

    const restarted = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })
    const report = await restarted.recover()

    expect(report).toMatchObject({
      recovered: [{ sessionId: 'session-1', paths: [...protectedAgentConfigPaths] }],
      conflicts: [],
      failed: [],
    })
    expect(await readFile(join(fixture.repo, '.claude/settings.json'), 'utf8')).toContain('head')
    expect(await git(fixture.repo, 'status', '--porcelain')).toBe('')
  })

  it('recovers a preparing manifest after a partially applied projection', async () => {
    const fixture = await createFixture()
    const crashed = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })
    await crashed.acquire(review(fixture))
    const manifestPath = join(fixture.stateDirectory, 'config-projections', 'session-1.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { status: string }
    manifest.status = 'preparing'
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    await writeFile(join(fixture.repo, '.mcp.json'), '{"server":"head"}\n')

    const restarted = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })
    const report = await restarted.recover()

    expect(report.recovered).toHaveLength(1)
    expect(report.conflicts).toEqual([])
    expect(await readFile(join(fixture.repo, '.claude/settings.json'), 'utf8')).toContain('head')
    expect(await readFile(join(fixture.repo, '.mcp.json'), 'utf8')).toContain('head')
    expect(await git(fixture.repo, 'status', '--porcelain')).toBe('')
  })

  it('preserves unexpected user edits and leaves the manifest for manual recovery', async () => {
    const fixture = await createFixture()
    const crashed = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })
    await crashed.acquire(review(fixture))
    await writeFile(join(fixture.repo, '.claude/settings.json'), '{"source":"user"}\n')

    const restarted = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })
    const report = await restarted.recover()

    expect(report.conflicts).toEqual([
      {
        sessionId: 'session-1',
        worktreePath: fixture.repo,
        paths: ['.claude/settings.json'],
      },
    ])
    expect(await readFile(join(fixture.repo, '.claude/settings.json'), 'utf8')).toContain('user')
    expect(await readdir(join(fixture.stateDirectory, 'config-projections'))).toEqual([
      'session-1.json',
    ])
  })

  it('fails closed for dirty config, a mismatched HEAD, and tracked symlinks', async () => {
    const fixture = await createFixture()
    const service = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })
    await writeFile(join(fixture.repo, '.claude/settings.json'), '{"source":"dirty"}\n')
    await expect(service.acquire(review(fixture))).rejects.toThrow(
      'Protected agent configuration is dirty',
    )

    await git(fixture.repo, 'reset', '--hard', fixture.headSha)
    await expect(service.acquire(review({ ...fixture, headSha: fixture.baseSha }))).rejects.toThrow(
      'Review worktree HEAD changed',
    )

    await unlink(join(fixture.repo, '.mcp.json'))
    await symlink('README.md', join(fixture.repo, '.mcp.json'))
    await git(fixture.repo, 'add', '.mcp.json')
    await git(fixture.repo, 'commit', '-m', 'symlink config')
    fixture.headSha = await git(fixture.repo, 'rev-parse', 'HEAD')
    await expect(service.acquire(review(fixture))).rejects.toBeInstanceOf(ConfigProjectionError)
    await expect(service.acquire(review(fixture))).rejects.toThrow(
      'Protected config is not a regular file',
    )
  })

  it('reports malformed crash manifests without deleting them', async () => {
    const fixture = await createFixture()
    const directory = join(fixture.stateDirectory, 'config-projections')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'broken.json'), '{}\n')
    const service = new WorktreeConfigProjection({ stateDirectory: fixture.stateDirectory })

    const report = await service.recover()

    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.message).toContain('Invalid config projection manifest')
    expect(await readdir(directory)).toEqual(['broken.json'])
  })
})

type Fixture = {
  root: string
  repo: string
  stateDirectory: string
  baseSha: string
  headSha: string
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'legible-config-projection-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const stateDirectory = join(root, 'state')
  await mkdir(join(repo, '.claude'), { recursive: true })
  await git(repo, 'init')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test User')
  await git(repo, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(repo, 'README.md'), 'fixture\n')
  await writeFile(join(repo, '.claude/settings.json'), '{"source":"base"}\n')
  await writeFile(join(repo, '.claude/settings.local.json'), '{"local":"base"}\n')
  await git(repo, 'add', '.')
  await git(repo, 'add', '-f', '.claude/settings.local.json')
  await git(repo, 'commit', '-m', 'base')
  const baseSha = await git(repo, 'rev-parse', 'HEAD')

  await writeFile(join(repo, '.claude/settings.json'), '{"source":"head"}\n')
  await unlink(join(repo, '.claude/settings.local.json'))
  await writeFile(join(repo, '.mcp.json'), '{"server":"head"}\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-m', 'head')
  const headSha = await git(repo, 'rev-parse', 'HEAD')
  return { root, repo, stateDirectory, baseSha, headSha }
}

function review(fixture: Pick<Fixture, 'repo' | 'baseSha' | 'headSha'>) {
  return {
    id: 'session-1',
    worktreePath: fixture.repo,
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return result.stdout.trim()
}
