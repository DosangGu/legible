import type { DiffDocument, DiffFile, DiffFileStatus, DiffHunk, DiffLine } from '@legible/protocol'

type MutableFile = {
  oldPath: string | null
  newPath: string | null
  status: DiffFileStatus
  isBinary: boolean
  oldMode?: string
  newMode?: string
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

type MutableHunk = DiffHunk & {
  nextLeftLine: number
  nextRightLine: number
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/u

export class DiffParseError extends Error {
  constructor(
    message: string,
    readonly lineNumber: number,
  ) {
    super(`Invalid unified diff at line ${String(lineNumber)}: ${message}`)
    this.name = 'DiffParseError'
  }
}

export class UnifiedDiffParser {
  readonly #baseSha: string
  readonly #headSha: string
  readonly #files: DiffFile[] = []
  #file: MutableFile | undefined
  #hunk: MutableHunk | undefined
  #lineNumber = 0
  #finished = false

  constructor(baseSha: string, headSha: string) {
    this.#baseSha = baseSha
    this.#headSha = headSha
  }

  push(line: string): void {
    if (this.#finished) throw new Error('Cannot push lines after finishing the diff parser')
    this.#lineNumber += 1
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line

    if (normalizedLine.startsWith('diff --git ')) {
      this.#finishFile()
      const [oldPath, newPath] = parseDiffHeader(normalizedLine, this.#lineNumber)
      this.#file = {
        oldPath,
        newPath,
        status: 'modified',
        isBinary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      }
      return
    }

    if (!this.#file) {
      if (normalizedLine !== '') this.#fail('expected a diff --git file header')
      return
    }

    if (normalizedLine.startsWith('@@ ')) {
      this.#finishHunk()
      this.#hunk = parseHunkHeader(normalizedLine, this.#lineNumber)
      return
    }

    if (this.#hunk) {
      this.#pushHunkLine(normalizedLine)
      return
    }

    this.#pushFileMetadata(normalizedLine)
  }

  finish(): DiffDocument {
    if (this.#finished) throw new Error('Diff parser has already finished')
    this.#finishFile()
    this.#finished = true
    const additions = this.#files.reduce((total, file) => total + file.additions, 0)
    const deletions = this.#files.reduce((total, file) => total + file.deletions, 0)

    return {
      baseSha: this.#baseSha,
      headSha: this.#headSha,
      additions,
      deletions,
      files: this.#files,
    }
  }

  #pushHunkLine(line: string): void {
    const hunk = this.#hunk
    const file = this.#file
    if (!hunk || !file) this.#fail('hunk line without an active hunk')

    if (line === '\\ No newline at end of file') {
      const previous = hunk.lines.at(-1)
      if (!previous || previous.noNewlineAtEnd) this.#fail('orphan no-newline marker')
      previous.noNewlineAtEnd = true
      return
    }

    const prefix = line[0]
    const content = line.slice(1)
    let parsed: DiffLine

    if (prefix === ' ') {
      parsed = {
        kind: 'context',
        content,
        leftLine: hunk.nextLeftLine,
        rightLine: hunk.nextRightLine,
        noNewlineAtEnd: false,
      }
      hunk.nextLeftLine += 1
      hunk.nextRightLine += 1
    } else if (prefix === '+') {
      parsed = {
        kind: 'addition',
        content,
        leftLine: null,
        rightLine: hunk.nextRightLine,
        noNewlineAtEnd: false,
      }
      hunk.nextRightLine += 1
      file.additions += 1
    } else if (prefix === '-') {
      parsed = {
        kind: 'deletion',
        content,
        leftLine: hunk.nextLeftLine,
        rightLine: null,
        noNewlineAtEnd: false,
      }
      hunk.nextLeftLine += 1
      file.deletions += 1
    } else {
      this.#fail(`unexpected hunk line prefix ${JSON.stringify(prefix ?? '')}`)
    }

    hunk.lines.push(parsed)
  }

  #pushFileMetadata(line: string): void {
    const file = this.#file
    if (!file) this.#fail('file metadata without an active file')

    if (line.startsWith('new file mode ')) {
      file.status = 'added'
      file.oldPath = null
      file.newMode = line.slice('new file mode '.length)
    } else if (line.startsWith('deleted file mode ')) {
      file.status = 'deleted'
      file.newPath = null
      file.oldMode = line.slice('deleted file mode '.length)
    } else if (line.startsWith('old mode ')) {
      file.oldMode = line.slice('old mode '.length)
    } else if (line.startsWith('new mode ')) {
      file.newMode = line.slice('new mode '.length)
    } else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = parseMetadataPath(line.slice('rename from '.length), this.#lineNumber)
    } else if (line.startsWith('rename to ')) {
      file.status = 'renamed'
      file.newPath = parseMetadataPath(line.slice('rename to '.length), this.#lineNumber)
    } else if (line.startsWith('--- ')) {
      file.oldPath = parsePatchPath(line.slice(4), 'a/', this.#lineNumber)
    } else if (line.startsWith('+++ ')) {
      file.newPath = parsePatchPath(line.slice(4), 'b/', this.#lineNumber)
    } else if (line.startsWith('Binary files ')) {
      file.isBinary = true
    } else if (
      line === '' ||
      line.startsWith('index ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('dissimilarity index ')
    ) {
      return
    } else {
      this.#fail(`unsupported file metadata ${JSON.stringify(line)}`)
    }
  }

  #finishHunk(): void {
    const hunk = this.#hunk
    if (!hunk) return
    const consumedOld = hunk.nextLeftLine - hunk.oldStart
    const consumedNew = hunk.nextRightLine - hunk.newStart
    if (consumedOld !== hunk.oldLines || consumedNew !== hunk.newLines) {
      this.#fail(
        `hunk declared -${String(hunk.oldLines)}/+${String(hunk.newLines)} lines but consumed -${String(consumedOld)}/+${String(consumedNew)}`,
      )
    }
    this.#file?.hunks.push(stripHunkCounters(hunk))
    this.#hunk = undefined
  }

  #finishFile(): void {
    this.#finishHunk()
    if (!this.#file) return
    if (this.#file.oldPath === null && this.#file.newPath === null) {
      this.#fail('file has neither an old path nor a new path')
    }
    this.#files.push(this.#file)
    this.#file = undefined
  }

  #fail(message: string): never {
    throw new DiffParseError(message, this.#lineNumber)
  }
}

export function parseUnifiedDiff(text: string, baseSha: string, headSha: string): DiffDocument {
  const parser = new UnifiedDiffParser(baseSha, headSha)
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) parser.push(line)
  return parser.finish()
}

function parseHunkHeader(line: string, lineNumber: number): MutableHunk {
  const match = hunkHeaderPattern.exec(line)
  if (!match?.[1] || !match[3]) throw new DiffParseError('malformed hunk header', lineNumber)
  const oldStart = Number(match[1])
  const oldLines = match[2] === undefined ? 1 : Number(match[2])
  const newStart = Number(match[3])
  const newLines = match[4] === undefined ? 1 : Number(match[4])
  const heading = match[5]

  return {
    oldStart,
    oldLines,
    newStart,
    newLines,
    ...(heading ? { heading } : {}),
    lines: [],
    nextLeftLine: oldStart,
    nextRightLine: newStart,
  }
}

function stripHunkCounters(hunk: MutableHunk): DiffHunk {
  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    ...(hunk.heading ? { heading: hunk.heading } : {}),
    lines: hunk.lines,
  }
}

function parseDiffHeader(line: string, lineNumber: number): [string, string] {
  const value = line.slice('diff --git '.length)
  if (value.startsWith('"')) {
    const tokens = parsePathTokens(value, lineNumber)
    if (tokens.length !== 2 || !tokens[0] || !tokens[1]) {
      throw new DiffParseError('malformed diff --git header', lineNumber)
    }
    return [stripPrefix(tokens[0], 'a/'), stripPrefix(tokens[1], 'b/')]
  }

  const candidates: Array<[string, string]> = []
  let separator = value.indexOf(' b/')
  while (separator !== -1) {
    const oldPath = value.slice(0, separator)
    const newPath = value.slice(separator + 1)
    if (oldPath.startsWith('a/') && newPath.startsWith('b/')) {
      candidates.push([oldPath.slice(2), newPath.slice(2)])
    }
    separator = value.indexOf(' b/', separator + 1)
  }
  const matching = candidates.find(([oldPath, newPath]) => oldPath === newPath)
  const parsed = matching ?? candidates.at(-1)
  if (!parsed) throw new DiffParseError('malformed diff --git header', lineNumber)
  return parsed
}

function parsePatchPath(value: string, prefix: 'a/' | 'b/', lineNumber: number): string | null {
  const path = parseSinglePath(value, lineNumber)
  if (path === '/dev/null') return null
  return stripPrefix(path, prefix)
}

function parseMetadataPath(value: string, lineNumber: number): string {
  return parseSinglePath(value, lineNumber)
}

function parseSinglePath(value: string, lineNumber: number): string {
  if (value.startsWith('"')) {
    const parsed = parseQuotedPath(value, 0, lineNumber)
    if (value.slice(parsed.nextIndex).trim() !== '') {
      throw new DiffParseError('characters after quoted path', lineNumber)
    }
    return parsed.value
  }
  const path = value.split('\t', 1)[0]
  if (!path) throw new DiffParseError('empty path', lineNumber)
  return path
}

function parsePathTokens(value: string, lineNumber: number): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < value.length) {
    while (value[index] === ' ') index += 1
    if (index >= value.length) break

    if (value[index] === '"') {
      const parsed = parseQuotedPath(value, index, lineNumber)
      tokens.push(parsed.value)
      index = parsed.nextIndex
      if (index < value.length && value[index] !== ' ') {
        throw new DiffParseError('characters after quoted path', lineNumber)
      }
    } else {
      const end = value.indexOf(' ', index)
      const nextIndex = end === -1 ? value.length : end
      tokens.push(value.slice(index, nextIndex))
      index = nextIndex
    }
  }
  return tokens
}

function parseQuotedPath(
  value: string,
  start: number,
  lineNumber: number,
): { value: string; nextIndex: number } {
  let result = ''
  let index = start + 1
  while (index < value.length) {
    const character = value[index]
    if (character === '"') return { value: result, nextIndex: index + 1 }
    if (character !== '\\') {
      result += character
      index += 1
      continue
    }

    const escaped = value[index + 1]
    if (escaped === undefined) break
    const escapeMap: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      a: '\u0007',
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
    }
    if (escapeMap[escaped] !== undefined) {
      result += escapeMap[escaped]
      index += 2
      continue
    }

    const octal = /^[0-7]{1,3}/u.exec(value.slice(index + 1))?.[0]
    if (!octal) throw new DiffParseError('unsupported quoted-path escape', lineNumber)
    result += String.fromCharCode(Number.parseInt(octal, 8))
    index += 1 + octal.length
  }
  throw new DiffParseError('unterminated quoted path', lineNumber)
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}
