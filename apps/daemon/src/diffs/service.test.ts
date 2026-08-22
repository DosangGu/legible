import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { reviewSession } from '../testing/fixtures.js'
import { DiffUnavailableError, SessionDiffService } from './service.js'
import { buildGitDiffArgs, NodeGitDiffSource } from './source.js'

const execFileAsync = promisify(execFile)

let repoPath: string
let baseSha: string
let headSha: string

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'legible-diff-'))
  await git('init')
  await git('config', 'user.name', 'Legible Test')
  await git('config', 'user.email', 'legible@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(repoPath, 'shared.txt'), 'base\n')
  await git('add', 'shared.txt')
  await git('commit', '-m', 'base')
  const mainBranch = await git('branch', '--show-current')

  await git('checkout', '-b', 'feature')
  await writeFile(join(repoPath, 'feature file.txt'), 'feature\n')
  await git('add', 'feature file.txt')
  await git('commit', '-m', 'feature')
  headSha = await git('rev-parse', 'HEAD')

  await git('checkout', mainBranch)
  await writeFile(join(repoPath, 'main-only.txt'), 'not part of the feature\n')
  await git('add', 'main-only.txt')
  await git('commit', '-m', 'main only')
  baseSha = await git('rev-parse', 'HEAD')
})

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true })
})

describe('SessionDiffService', () => {
  it('reads a three-dot diff from Git and excludes base-only changes', async () => {
    const service = new SessionDiffService(new NodeGitDiffSource())
    const document = await service.get(reviewSession({ worktreePath: repoPath, baseSha, headSha }))

    expect(document.files.map(({ newPath }) => newPath)).toEqual(['feature file.txt'])
    expect(document).toMatchObject({ baseSha, headSha, additions: 1, deletions: 0 })
  })

  it('returns an empty document when both revisions are the same', async () => {
    const service = new SessionDiffService(new NodeGitDiffSource())

    await expect(
      service.get(reviewSession({ worktreePath: repoPath, baseSha: headSha, headSha })),
    ).resolves.toEqual({ baseSha: headSha, headSha, additions: 0, deletions: 0, files: [] })
  })

  it('maps missing revisions to a diff-unavailable error', async () => {
    const service = new SessionDiffService(new NodeGitDiffSource())

    await expect(
      service.get(reviewSession({ worktreePath: repoPath, baseSha: 'f'.repeat(40), headSha })),
    ).rejects.toBeInstanceOf(DiffUnavailableError)
  })

  it('rejects non-SHA revisions before spawning Git', async () => {
    const service = new SessionDiffService({
      read() {
        throw new Error('source should not run')
      },
    })

    await expect(service.get(reviewSession())).rejects.toThrow('invalid Git revision')
  })
})

describe('buildGitDiffArgs', () => {
  it('pins safe three-dot diff options and terminates revision arguments', () => {
    expect(buildGitDiffArgs('a'.repeat(40), 'b'.repeat(40))).toEqual([
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      `${'a'.repeat(40)}...${'b'.repeat(40)}`,
      '--',
    ])
  })
})

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, encoding: 'utf8' })
  return stdout.trim()
}
