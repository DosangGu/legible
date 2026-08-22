import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { reviewSession } from '../testing/fixtures.js'
import { ReviewFileNotFoundError, SessionFileService } from './file-service.js'
import { NodeGitFileSource } from './file-source.js'
import { SessionDiffService } from './service.js'
import { NodeGitDiffSource } from './source.js'

const execFileAsync = promisify(execFile)

let repoPath: string
let baseSha: string
let headSha: string
let service: SessionFileService

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'legible-file-'))
  await git('init')
  await git('config', 'user.name', 'Legible Test')
  await git('config', 'user.email', 'legible@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(repoPath, 'deleted.txt'), 'deleted contents\n')
  await writeFile(join(repoPath, 'old name.txt'), 'renamed contents\n')
  await git('add', '.')
  await git('commit', '-m', 'base')
  baseSha = await git('rev-parse', 'HEAD')

  await git('rm', 'deleted.txt')
  await git('mv', 'old name.txt', 'new name.txt')
  await writeFile(join(repoPath, 'added.txt'), 'added contents\n')
  await writeFile(join(repoPath, 'image.bin'), new Uint8Array([0, 1, 2, 3]))
  await git('add', '.')
  await git('commit', '-m', 'head')
  headSha = await git('rev-parse', 'HEAD')
  service = new SessionFileService(
    new SessionDiffService(new NodeGitDiffSource()),
    new NodeGitFileSource(),
  )
})

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true })
})

describe('SessionFileService', () => {
  it('reads added, deleted, and renamed files from the authorized side', async () => {
    const session = reviewSession({ worktreePath: repoPath, baseSha, headSha })

    await expect(service.get(session, 'added.txt', 'RIGHT')).resolves.toMatchObject({
      path: 'added.txt',
      side: 'RIGHT',
      sha: headSha,
      content: 'added contents\n',
      isBinary: false,
    })
    await expect(service.get(session, 'deleted.txt', 'LEFT')).resolves.toMatchObject({
      side: 'LEFT',
      sha: baseSha,
      content: 'deleted contents\n',
    })
    await expect(service.get(session, 'new name.txt', 'RIGHT')).resolves.toMatchObject({
      content: 'renamed contents\n',
    })
  })

  it('returns binary metadata without decoding content', async () => {
    const session = reviewSession({ worktreePath: repoPath, baseSha, headSha })

    await expect(service.get(session, 'image.bin', 'RIGHT')).resolves.toEqual({
      path: 'image.bin',
      side: 'RIGHT',
      sha: headSha,
      content: null,
      isBinary: true,
      byteLength: 4,
    })
  })

  it('does not expose files outside the normalized session diff', async () => {
    const session = reviewSession({ worktreePath: repoPath, baseSha, headSha })

    await expect(service.get(session, '.git/config', 'RIGHT')).rejects.toBeInstanceOf(
      ReviewFileNotFoundError,
    )
    await expect(service.get(session, 'added.txt', 'LEFT')).rejects.toBeInstanceOf(
      ReviewFileNotFoundError,
    )
  })
})

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, encoding: 'utf8' })
  return stdout.trim()
}
