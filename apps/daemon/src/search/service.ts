import type {
  CodeSearchMatch,
  CodeSearchResult,
  ReviewFileContent,
  ReviewSession,
} from '@legible/protocol'
import { ServiceError } from '../common/service-error.js'
import type { SessionRegistry } from '../sessions/session-registry.js'
import { readGit, type GitReader } from './git.js'

const maxFileBytes = 1024 * 1024
const maxTreeBytes = 8 * 1024 * 1024
const maxSearchBytes = 2 * 1024 * 1024
const maxMatches = 200
const timeoutMs = 5_000
type TreeFile = { path: string; oid: string; size: number }

export class CodeSearchService {
  readonly #active = new Set<string>()
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly git: GitReader = readGit,
  ) {}

  async search(id: string, query: unknown, signal?: AbortSignal): Promise<CodeSearchResult> {
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      Buffer.byteLength(query) > 256 ||
      /[\0\r\n]/u.test(query)
    )
      throw new ServiceError(
        'invalid_search_query',
        'Enter a single-line literal query of 1–256 UTF-8 bytes',
      )
    return this.run(id, signal, async (session, deadline) => {
      const files = await this.tree(session, deadline, signal)
      const eligible = files.filter((file) => file.size <= maxFileBytes)
      const matches: CodeSearchMatch[] = []
      let remaining = maxSearchBytes
      let truncated = false
      for (let index = 0; index < eligible.length;) {
        if (Date.now() >= deadline || remaining <= 0) {
          truncated = true
          break
        }
        // Bound argv as well as process output; literal pathspecs keep metacharacters inert.
        const batch: TreeFile[] = []
        let pathBytes = 0
        while (index < eligible.length && batch.length < 64 && pathBytes < 32_000) {
          const file = eligible[index++]!
          batch.push(file)
          pathBytes += Buffer.byteLength(file.path)
        }
        const parser = new GrepParser(
          session.headSha,
          new Set(batch.map((file) => file.path)),
          matches,
          query,
        )
        const result = await this.git(
          [
            '-c',
            'grep.heading=false',
            '-c',
            'grep.break=false',
            '-c',
            'grep.column=false',
            '-c',
            'submodule.recurse=false',
            'grep',
            '-H',
            '-n',
            '-z',
            '-F',
            '-I',
            '--no-color',
            '--no-textconv',
            '--no-recurse-submodules',
            '--full-name',
            '--threads=1',
            '-A0',
            '-B0',
            '-e',
            query,
            session.headSha,
            '--',
            ...batch.map((file) => file.path),
          ],
          {
            cwd: session.worktreePath,
            timeoutMs: deadline - Date.now(),
            maxBytes: remaining,
            signal,
            onChunk: (chunk) => {
              remaining -= chunk.length
              return parser.push(chunk)
            },
          },
        )
        if (result.limited) {
          truncated = true
          break
        }
        if (result.exitCode !== 0 && result.exitCode !== 1) throw unavailable()
        parser.finish()
      }
      return {
        reviewRevision: session.reviewRevision ?? 0,
        headSha: session.headSha,
        query,
        matches: matches.slice(0, maxMatches),
        truncated,
        skippedLargeFiles: files.length - eligible.length,
      }
    })
  }

  async file(id: string, path: unknown, signal?: AbortSignal): Promise<ReviewFileContent> {
    if (typeof path !== 'string' || !safePath(path))
      throw new ServiceError('invalid_search_path', 'Enter a repository-relative file path')
    return this.run(id, signal, async (session, deadline) => {
      const files = await this.tree(session, deadline, signal, path)
      const file = files.find((file) => file.path === path)
      if (!file)
        throw new ServiceError(
          'search_file_not_found',
          'Not a regular tracked file in the pinned HEAD',
          404,
        )
      if (file.size > maxFileBytes)
        throw new ServiceError('search_file_too_large', 'File exceeds the 1 MiB preview limit', 413)
      const result = await this.git(['cat-file', 'blob', file.oid], {
        cwd: session.worktreePath,
        timeoutMs: deadline - Date.now(),
        maxBytes: maxFileBytes,
        signal,
      })
      if (result.limited || result.exitCode !== 0) throw unavailable()
      if (result.bytes.includes(0))
        throw new ServiceError(
          'search_file_binary',
          'Binary files cannot be opened in code search',
          415,
        )
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)
      } catch {
        throw new ServiceError(
          'search_file_encoding',
          'Code search previews require UTF-8 text',
          415,
        )
      }
      return {
        path,
        side: 'RIGHT',
        sha: session.headSha,
        byteLength: result.bytes.length,
        content,
        isBinary: false,
      }
    })
  }

  private async tree(
    session: ReviewSession,
    deadline: number,
    signal?: AbortSignal,
    path?: string,
  ): Promise<TreeFile[]> {
    const result = await this.git(
      ['ls-tree', '-r', '-l', '-z', '--full-tree', session.headSha, ...(path ? ['--', path] : [])],
      {
        cwd: session.worktreePath,
        timeoutMs: deadline - Date.now(),
        maxBytes: maxTreeBytes,
        signal,
      },
    )
    if (result.limited)
      throw new ServiceError(
        'search_tree_limit',
        'Repository tree exceeds search limits; try again or use a smaller repository',
        413,
      )
    if (result.exitCode !== 0) throw unavailable()
    const files: TreeFile[] = []
    let listing: string
    try {
      listing = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)
    } catch {
      throw new ServiceError(
        'search_tree_encoding',
        'Code search requires UTF-8 repository paths',
        415,
      )
    }
    for (const record of listing.split('\0')) {
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+)\t([\s\S]+)$/u.exec(
        record,
      )
      if (match && safePath(match[4]!))
        files.push({ path: match[4]!, oid: match[2]!, size: Number(match[3]) })
    }
    return files
  }

  private async run<T>(
    id: string,
    signal: AbortSignal | undefined,
    operation: (session: ReviewSession, deadline: number) => Promise<T>,
  ): Promise<T> {
    this.sessions.assertMutable(id)
    const session = this.sessions.get(id)
    if (!session) throw new ServiceError('session_not_found', 'Review session not found', 404)
    if (session.submission)
      throw new ServiceError(
        'search_unavailable',
        'Continue reviewing before searching this submitted session',
        409,
      )
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(session.headSha)) throw unavailable()
    if (signal?.aborted) throw new ServiceError('search_cancelled', 'Search cancelled', 499)
    if (this.#active.has(id) || this.#active.size >= 4)
      throw new ServiceError('search_busy', 'Another code search is running; retry shortly', 429)
    this.#active.add(id)
    try {
      const result = await operation(session, Date.now() + timeoutMs)
      this.sessions.assertMutable(id)
      const current = this.sessions.get(id)
      if (
        !current ||
        current.headSha !== session.headSha ||
        (current.reviewRevision ?? 0) !== (session.reviewRevision ?? 0)
      )
        throw new ServiceError(
          'stale_review_revision',
          'Review changed. Search the refreshed revision.',
          409,
        )
      if (current.submission) throw unavailable()
      return result
    } finally {
      this.#active.delete(id)
    }
  }
}

/** Parse NUL-delimited names/line numbers; filenames themselves may contain newlines. */
export class GrepParser {
  #buffer = Buffer.alloc(0)
  #path: string | undefined
  #line: number | undefined
  constructor(
    private readonly sha: string,
    private readonly paths: Set<string>,
    private readonly matches: CodeSearchMatch[],
    private readonly query: string,
  ) {}
  push(chunk: Buffer): boolean {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (true) {
      const delimiter = this.#buffer.indexOf(
        this.#path === undefined || this.#line === undefined ? 0 : 10,
      )
      if (delimiter < 0) return true
      const token = this.#buffer.subarray(0, delimiter)
      this.#buffer = this.#buffer.subarray(delimiter + 1)
      if (this.#path === undefined) {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(token)
        if (!value.startsWith(`${this.sha}:`) || !this.paths.has(value.slice(this.sha.length + 1)))
          throw unavailable()
        this.#path = value.slice(this.sha.length + 1)
      } else if (this.#line === undefined) {
        const value = token.toString('ascii')
        if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)))
          throw unavailable()
        this.#line = Number(value)
      } else {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(token)
          const at = text.indexOf(this.query)
          if (!token.includes(0) && at >= 0) {
            const start = Math.max(0, at - 80),
              end = Math.min(text.length, start + 400)
            this.matches.push({
              path: this.#path,
              line: this.#line,
              preview: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
            })
          }
        } catch {
          /* Non-UTF-8 text is not a safe browser preview. */
        }
        this.#path = undefined
        this.#line = undefined
        if (this.matches.length > maxMatches) return false
      }
    }
  }
  finish(): void {
    if (this.#buffer.length || this.#path !== undefined || this.#line !== undefined)
      throw unavailable()
  }
}

function safePath(path: string): boolean {
  return (
    Boolean(path) &&
    Buffer.byteLength(path) <= 4096 &&
    !/[\0\\]/u.test(path) &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:\//u.test(path) &&
    path
      .split('/')
      .every(
        (part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git',
      )
  )
}
function unavailable() {
  return new ServiceError(
    'search_unavailable',
    'Pinned Git content is unavailable for code search',
    409,
  )
}
