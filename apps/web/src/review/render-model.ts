import type {
  DiffDocument,
  DiffFile,
  DiffLineKind,
  DiffSide,
  ReviewFileContent,
} from '@legible/protocol'

export type DiffAnchor = {
  path: string
  line: number
  side: DiffSide
  rangeKey: string
}

export type RenderLineKind = DiffLineKind | 'file' | 'hunk' | 'metadata' | 'whole'

export type RenderLine = {
  kind: RenderLineKind
  leftAnchor?: DiffAnchor
  rightAnchor?: DiffAnchor
  changed?: boolean
}

export type RenderedFile = {
  index: number
  path: string
  startLine: number
  source: DiffFile
}

export type RenderModel = {
  document: string
  lines: RenderLine[]
  files: RenderedFile[]
}

export function buildDiffRenderModel(diff: DiffDocument): RenderModel {
  const text: string[] = []
  const lines: RenderLine[] = []
  const files: RenderedFile[] = []

  const push = (value: string, line: RenderLine) => {
    text.push(value)
    lines.push(line)
  }

  diff.files.forEach((file, index) => {
    const path = file.newPath ?? file.oldPath ?? '(unknown file)'
    files.push({ index, path, startLine: lines.length + 1, source: file })
    push(fileHeader(file), { kind: 'file' })

    if (file.oldMode || file.newMode) {
      push(`mode ${file.oldMode ?? '—'} → ${file.newMode ?? '—'}`, { kind: 'metadata' })
    }
    if (file.status === 'renamed' && file.hunks.length === 0) {
      push(`renamed ${file.oldPath ?? '—'} → ${file.newPath ?? '—'}`, { kind: 'metadata' })
    }
    if (file.isBinary) push('Binary file — preview unavailable', { kind: 'metadata' })

    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      const rangeKey = hunkRangeKey(file, hunkIndex)
      const heading = hunk.heading ? ` ${hunk.heading}` : ''
      push(
        `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@${heading}`,
        { kind: 'hunk' },
      )
      for (const line of hunk.lines) {
        const leftAnchor =
          line.leftLine === null || file.oldPath === null
            ? undefined
            : { path: file.oldPath, line: line.leftLine, side: 'LEFT' as const, rangeKey }
        const rightAnchor =
          line.rightLine === null || file.newPath === null
            ? undefined
            : { path: file.newPath, line: line.rightLine, side: 'RIGHT' as const, rangeKey }
        const prefix = line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '
        push(`${prefix}${line.content}`, {
          kind: line.kind,
          ...(leftAnchor ? { leftAnchor } : {}),
          ...(rightAnchor ? { rightAnchor } : {}),
        })
        if (line.noNewlineAtEnd) push('\\ No newline at end of file', { kind: 'metadata' })
      }
    }
  })

  return { document: text.join('\n'), lines, files }
}

export function buildWholeFileRenderModel(content: ReviewFileContent, file: DiffFile): RenderModel {
  const document = content.content ?? ''
  const sourceLines = document.split('\n')
  const changed = changedLines(file, content.side)
  const commentable = commentableLines(file, content.side)
  const lines = sourceLines.map<RenderLine>((_line, index) => {
    const line = index + 1
    const isTrailingPhantom = index === sourceLines.length - 1 && document.endsWith('\n')
    if (isTrailingPhantom) return { kind: 'whole' }
    const rangeKey = commentable.get(line)
    const anchor = rangeKey ? { path: content.path, line, side: content.side, rangeKey } : undefined
    return {
      kind: 'whole',
      ...(anchor && content.side === 'LEFT' ? { leftAnchor: anchor } : {}),
      ...(anchor && content.side === 'RIGHT' ? { rightAnchor: anchor } : {}),
      changed: changed.has(line),
    }
  })

  return {
    document,
    lines,
    files: [{ index: 0, path: content.path, startLine: 1, source: file }],
  }
}

function commentableLines(file: DiffFile, side: DiffSide): Map<number, string> {
  const lines = new Map<number, string>()
  file.hunks.forEach((hunk, hunkIndex) => {
    for (const line of hunk.lines) {
      const value = side === 'LEFT' ? line.leftLine : line.rightLine
      if (value !== null) lines.set(value, hunkRangeKey(file, hunkIndex))
    }
  })
  return lines
}

function hunkRangeKey(file: DiffFile, hunkIndex: number): string {
  return `${file.oldPath ?? '/dev/null'}:${file.newPath ?? '/dev/null'}:${String(hunkIndex)}`
}

export function defaultFileTarget(file: DiffFile): { path: string; side: DiffSide } {
  if (file.newPath !== null) return { path: file.newPath, side: 'RIGHT' }
  if (file.oldPath !== null) return { path: file.oldPath, side: 'LEFT' }
  throw new Error('Diff file has no path')
}

export function sameAnchor(left: DiffAnchor | undefined, right: DiffAnchor | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.path === right.path &&
    left.line === right.line &&
    left.side === right.side
  )
}

function fileHeader(file: DiffFile): string {
  const oldPath = file.oldPath ?? '/dev/null'
  const newPath = file.newPath ?? '/dev/null'
  return `${file.status.toUpperCase()}  ${oldPath} → ${newPath}  +${String(file.additions)} −${String(file.deletions)}`
}

function changedLines(file: DiffFile, side: DiffSide): Set<number> {
  const lines = new Set<number>()
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (side === 'LEFT' && line.kind === 'deletion' && line.leftLine !== null) {
        lines.add(line.leftLine)
      }
      if (side === 'RIGHT' && line.kind === 'addition' && line.rightLine !== null) {
        lines.add(line.rightLine)
      }
    }
  }
  return lines
}
