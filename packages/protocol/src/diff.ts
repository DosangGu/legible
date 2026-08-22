export type DiffLineKind = 'context' | 'addition' | 'deletion'

export type DiffLine = {
  kind: DiffLineKind
  content: string
  leftLine: number | null
  rightLine: number | null
  noNewlineAtEnd: boolean
}

export type DiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  heading?: string
  lines: DiffLine[]
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export type DiffFile = {
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

export type DiffDocument = {
  baseSha: string
  headSha: string
  additions: number
  deletions: number
  files: DiffFile[]
}
