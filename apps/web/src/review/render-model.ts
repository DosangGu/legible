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

    for (const hunk of file.hunks) {
      const heading = hunk.heading ? ` ${hunk.heading}` : ''
      push(
        `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@${heading}`,
        { kind: 'hunk' },
      )
      for (const line of hunk.lines) {
        const leftAnchor =
          line.leftLine === null || file.oldPath === null
            ? undefined
            : { path: file.oldPath, line: line.leftLine, side: 'LEFT' as const }
        const rightAnchor =
          line.rightLine === null || file.newPath === null
            ? undefined
            : { path: file.newPath, line: line.rightLine, side: 'RIGHT' as const }
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
  const lines = sourceLines.map<RenderLine>((_line, index) => {
    const line = index + 1
    const isTrailingPhantom = index === sourceLines.length - 1 && document.endsWith('\n')
    if (isTrailingPhantom) return { kind: 'whole' }
    const anchor = { path: content.path, line, side: content.side }
    return {
      kind: 'whole',
      ...(content.side === 'LEFT' ? { leftAnchor: anchor } : { rightAnchor: anchor }),
      changed: changed.has(line),
    }
  })

  return {
    document,
    lines,
    files: [{ index: 0, path: content.path, startLine: 1, source: file }],
  }
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
