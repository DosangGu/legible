import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { git, repositoryFixture } from '../testing/repository.js'
import { reviewSession } from '../testing/fixtures.js'
import { EventBus } from '../events/event-bus.js'
import { SessionRegistry } from '../sessions/session-registry.js'
import { CodeSearchService, GrepParser } from './service.js'
import { readGit, type GitReader } from './git.js'
import type { CodeSearchMatch } from '@legible/protocol'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const f = await repositoryFixture()
  roots.push(f.root)
  await mkdir(join(f.checkout, 'src'))
  await writeFile(join(f.checkout, 'src/helper.ts'), 'needle first\n한글 needle 🙂\nneedle final')
  await writeFile(join(f.checkout, 'a:b [x]*\nname.ts'), 'needle with unusual filename\n')
  await writeFile(join(f.checkout, ':(glob)*'), 'needle literal path\n')
  await writeFile(join(f.checkout, 'image.bin'), Buffer.from('needle\0binary\n'))
  await writeFile(join(f.checkout, 'large.txt'), 'needle'.repeat(180_000))
  await symlink('/etc/passwd', join(f.checkout, 'outside-link'))
  await git(f.checkout, 'add', '.')
  await git(f.checkout, 'commit', '-m', 'search fixture')
  const headSha = await git(f.checkout, 'rev-parse', 'HEAD')
  const sessions = new SessionRegistry(new EventBus())
  const session = reviewSession({
    id: 'search-session',
    reviewRevision: 3,
    headSha,
    baseSha: headSha,
    worktreePath: f.checkout,
  })
  sessions.add(session)
  return { ...f, session, sessions, search: new CodeSearchService(sessions) }
}

describe('pinned HEAD code search', () => {
  it('searches committed regular blobs only, with accurate Unicode/newline paths and real line numbers', async () => {
    const f = await setup()
    await writeFile(join(f.checkout, 'src/helper.ts'), 'local uncommitted content\n')
    await writeFile(join(f.checkout, '.env'), 'needle untracked secret\n')
    const result = await f.search.search(f.session.id, 'needle')
    expect(result).toMatchObject({
      reviewRevision: 3,
      headSha: f.session.headSha,
      truncated: false,
      skippedLargeFiles: 1,
    })
    expect(result.matches).toHaveLength(5)
    expect(result.matches).toContainEqual({
      path: 'src/helper.ts',
      line: 2,
      preview: '한글 needle 🙂',
    })
    expect(result.matches).toContainEqual({
      path: 'a:b [x]*\nname.ts',
      line: 1,
      preview: 'needle with unusual filename',
    })
    expect(result.matches.map((match) => match.path)).not.toContain('.env')
    expect(result.matches.map((match) => match.path)).not.toContain('image.bin')
    expect((await f.search.search(f.session.id, 'Needle')).matches).toEqual([])
    expect((await f.search.search(f.session.id, 'root:')).matches).toEqual([])
    expect((await f.search.file(f.session.id, 'src/helper.ts')).content).toBe(
      'needle first\n한글 needle 🙂\nneedle final',
    )
    expect((await f.search.file(f.session.id, ':(glob)*')).content).toContain('literal path')
    expect((await f.search.file(f.session.id, 'a:b [x]*\nname.ts')).path).toBe('a:b [x]*\nname.ts')
  })

  it('bounds results and previews, and treats metacharacters and leading hyphens as literal text', async () => {
    const f = await setup()
    await writeFile(join(f.checkout, 'many.txt'), `${'needle\n'.repeat(240)}--help [a-z].*\n`)
    await git(f.checkout, 'add', '.')
    await git(f.checkout, 'commit', '-m', 'many matches')
    f.sessions.replace({ ...f.session, headSha: await git(f.checkout, 'rev-parse', 'HEAD') })
    const result = await f.search.search(f.session.id, 'needle')
    expect(result.matches).toHaveLength(200)
    expect(result.truncated).toBe(true)
    expect((await f.search.search(f.session.id, '--help [a-z].*')).matches).toHaveLength(1)
    expect((await f.search.search(f.session.id, 'does not exist')).matches).toEqual([])
  })

  it('rejects traversal, options, symlinks, directories, oversized files, binaries, and invalid queries', async () => {
    const f = await setup()
    for (const path of [
      '../README.md',
      '/etc/passwd',
      'src/../example.ts',
      '.git/config',
      'C:\\data',
      'src\\helper.ts',
      'src//helper.ts',
    ])
      await expect(f.search.file(f.session.id, path)).rejects.toMatchObject({
        code: 'invalid_search_path',
      })
    for (const path of ['outside-link', 'src', 'missing', '--help', '.env'])
      await expect(f.search.file(f.session.id, path)).rejects.toMatchObject({
        code: 'search_file_not_found',
      })
    await expect(f.search.file(f.session.id, 'large.txt')).rejects.toMatchObject({
      statusCode: 413,
    })
    await expect(f.search.file(f.session.id, 'image.bin')).rejects.toMatchObject({
      statusCode: 415,
    })
    for (const query of [undefined, '', ' ', 'a\nb', 'a\0b', 'a'.repeat(257), '한'.repeat(100)])
      await expect(f.search.search(f.session.id, query)).rejects.toMatchObject({
        code: 'invalid_search_query',
      })
  })

  it('rejects obsolete results and simultaneous requests, and releases its slot on failure', async () => {
    const f = await setup()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const reader: GitReader = async (...args) => {
      await waiting
      return readGit(...args)
    }
    const search = new CodeSearchService(f.sessions, reader)
    const pending = search.search(f.session.id, 'needle')
    await expect(search.search(f.session.id, 'other')).rejects.toMatchObject({
      code: 'search_busy',
    })
    f.sessions.replace({ ...f.session, reviewRevision: 4 })
    release()
    await expect(pending).rejects.toMatchObject({ code: 'stale_review_revision' })
    expect((await search.search(f.session.id, 'needle')).reviewRevision).toBe(4)
  })

  it('reports bounded output as partial, and fails closed on incomplete tree enumeration', async () => {
    const f = await setup()
    const limited: GitReader = async (args, options) => {
      if (args.includes('grep')) {
        options.onChunk?.(Buffer.from(`${f.session.headSha}:src/helper.ts\0` + '1\0needle first\n'))
        return { bytes: Buffer.alloc(0), limited: true, exitCode: 1 }
      }
      return readGit(args, options)
    }
    const result = await new CodeSearchService(f.sessions, limited).search(f.session.id, 'needle')
    expect(result).toMatchObject({ truncated: true, matches: [{ path: 'src/helper.ts', line: 1 }] })
    const treeLimited: GitReader = async () => ({
      bytes: Buffer.alloc(0),
      limited: true,
      exitCode: 1,
    })
    await expect(
      new CodeSearchService(f.sessions, treeLimited).search(f.session.id, 'needle'),
    ).rejects.toMatchObject({ code: 'search_tree_limit' })
  })

  it('cancels bounded Git reads and caps captured bytes', async () => {
    const f = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(
      readGit(['status'], {
        cwd: f.checkout,
        timeoutMs: 5_000,
        maxBytes: 1024,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'search_cancelled' })
    const limited = await readGit(['show', `${f.session.headSha}:large.txt`], {
      cwd: f.checkout,
      timeoutMs: 5_000,
      maxBytes: 50,
    })
    expect(limited.limited).toBe(true)
    expect(limited.bytes.length).toBe(50)
    const running = new AbortController()
    await expect(
      readGit(['show', `${f.session.headSha}:large.txt`], {
        cwd: f.checkout,
        timeoutMs: 5_000,
        maxBytes: 2_000_000,
        signal: running.signal,
        onChunk: () => {
          running.abort()
          return true
        },
      }),
    ).rejects.toMatchObject({ code: 'search_cancelled' })
  })

  it('kills a Git child when its execution deadline expires', async () => {
    const f = await setup()
    vi.useFakeTimers()
    try {
      const pending = readGit(['show', `${f.session.headSha}:large.txt`], {
        cwd: f.checkout,
        timeoutMs: 10,
        maxBytes: 2_000_000,
      })
      vi.advanceTimersByTime(10)
      expect((await pending).limited).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps concurrent operations across sessions and rejects submitted sessions', async () => {
    const f = await setup()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const reader: GitReader = async (...args) => {
      await waiting
      return readGit(...args)
    }
    const search = new CodeSearchService(f.sessions, reader)
    for (let index = 0; index < 5; index++)
      f.sessions.add({ ...f.session, id: `session-${String(index)}` })
    const pending = [0, 1, 2, 3].map((index) => search.search(`session-${String(index)}`, 'needle'))
    await expect(search.file('session-4', 'src/helper.ts')).rejects.toMatchObject({
      code: 'search_busy',
    })
    release()
    await Promise.all(pending)
    expect((await search.file('session-4', 'src/helper.ts')).content).toContain('needle')
    f.sessions.replace({
      ...f.session,
      submission: {
        status: 'uncertain',
        event: 'COMMENT',
        marker: 'marker',
        startedAt: '',
        currentHeadSha: f.session.headSha,
        staleHead: false,
      },
    })
    await expect(search.search(f.session.id, 'needle')).rejects.toMatchObject({
      code: 'search_unavailable',
    })
  })
})

describe('grep record parsing', () => {
  it('handles every byte boundary without confusing a newline in a path with a record boundary', () => {
    const matches: CodeSearchMatch[] = []
    const path = 'a\n한글:1.ts',
      sha = 'a'.repeat(40)
    const parser = new GrepParser(sha, new Set([path]), matches, '🙂')
    const bytes = Buffer.from(`${sha}:${path}\0` + '123\0prefix 🙂 suffix\n')
    for (const byte of bytes) parser.push(Buffer.from([byte]))
    parser.finish()
    expect(matches).toEqual([{ path, line: 123, preview: 'prefix 🙂 suffix' }])
  })
})
