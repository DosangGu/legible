import type { DraftComment, ReviewSession } from '@legible/protocol'
import type { CommandRunner } from '../preflight/command-runner.js'
import { NodeGitFileSource } from '../diffs/file-source.js'
import { InvalidCommentError, type CommentService } from './service.js'

type Entry = { oid: string; path: string }

/** Conservative, exact mapping. Ambiguous/mutated ranges never become submit-ready. */
export class CommentRelocator {
  constructor(
    private readonly runner: CommandRunner,
    private readonly comments: CommentService,
  ) {}

  async relocate(previous: ReviewSession, next: ReviewSession): Promise<DraftComment[]> {
    const result: DraftComment[] = []
    const trees = new Map<string, Promise<Entry[]>>()
    const tree = (sha: string) => {
      let value = trees.get(sha)
      if (!value) {
        value = this.git(next.worktreePath, ['ls-tree', '-rz', '--full-tree', sha]).then((output) =>
          output.split('\0').flatMap((record) => {
            const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/u.exec(record)
            return match ? [{ oid: match[2]!, path: match[3]! }] : []
          }),
        )
        trees.set(sha, value)
      }
      return value
    }
    const source = new NodeGitFileSource()
    for (const comment of previous.comments) {
      const pending: DraftComment = {
        ...comment,
        anchorStatus: 'needs_review',
        anchorRevision: comment.anchorRevision ?? previous.reviewRevision ?? 0,
      }
      if (comment.anchorStatus === 'needs_review') {
        result.push(pending)
        continue
      }
      const oldSha = comment.side === 'LEFT' ? previous.baseSha : previous.headSha
      const newSha = comment.side === 'LEFT' ? next.baseSha : next.headSha
      const oldTree = await tree(oldSha)
      const oldEntry = oldTree.find((entry) => entry.path === comment.path)
      const newTree = await tree(newSha)
      let entry = newTree.find((entry) => entry.path === comment.path)
      if (!entry && oldEntry) {
        const matches = newTree.filter((candidate) => candidate.oid === oldEntry.oid)
        if (
          matches.length === 1 &&
          oldTree.filter((candidate) => candidate.oid === oldEntry.oid).length === 1 &&
          !oldTree.some((candidate) => candidate.path === matches[0]?.path)
        )
          entry = matches[0]
      }
      if (!oldEntry || !entry) {
        result.push(pending)
        continue
      }
      let start = comment.startLine ?? comment.line
      let end = comment.line
      if (entry.oid !== oldEntry.oid) {
        const [oldBytes, newBytes, patch] = await Promise.all([
          source.read({ cwd: next.worktreePath, sha: oldSha, path: comment.path }),
          source.read({ cwd: next.worktreePath, sha: newSha, path: entry.path }),
          this.git(next.worktreePath, [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--no-color',
            '--unified=0',
            oldSha,
            newSha,
            '--',
            comment.path,
          ]),
        ])
        if (oldBytes.includes(0) || newBytes.includes(0)) {
          result.push(pending)
          continue
        }
        let before: string, after: string
        try {
          const decoder = new TextDecoder('utf-8', { fatal: true })
          before = decoder.decode(oldBytes)
          after = decoder.decode(newBytes)
        } catch {
          result.push(pending)
          continue
        }
        const mapped = mapRange(before, after, patch, start, end)
        if (!mapped) {
          result.push(pending)
          continue
        }
        start = mapped.start
        end = mapped.end
      }
      const moved: DraftComment = {
        ...comment,
        path: entry.path,
        line: end,
        ...(comment.startLine === undefined ? {} : { startLine: start }),
        anchorStatus: 'current',
        anchorRevision: next.reviewRevision ?? 0,
      }
      try {
        await this.comments.validateAnchor(next, moved)
        result.push(moved)
      } catch (error) {
        if (!(error instanceof InvalidCommentError)) throw error
        result.push(pending)
      }
    }
    return result
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.runner.run('git', ['--literal-pathspecs', ...args], {
      cwd,
      timeoutMs: 60_000,
    })
    if (result.status !== 'completed' || result.exitCode !== 0)
      throw new Error('Unable to compare comment revisions')
    return result.stdout
  }
}

export function mapRange(
  before: string,
  after: string,
  patch: string,
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  let offset = 0
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const from = Number(match[1]),
      removed = Number(match[2] ?? 1),
      added = Number(match[4] ?? 1)
    if (removed === 0) {
      if (from >= start && from < end) return undefined
      if (from < start) offset += added
    } else {
      if (from <= end && from + removed - 1 >= start) return undefined
      if (from + removed - 1 < start) offset += added - removed
    }
  }
  const oldLines = before.split('\n'),
    newLines = after.split('\n')
  const contextStart = Math.max(0, start - 4)
  const context = oldLines.slice(contextStart, Math.min(oldLines.length, end + 3))
  const mapped = contextStart + offset
  if (
    !context.length ||
    mapped < 0 ||
    !context.every((line, index) => line === newLines[mapped + index])
  )
    return undefined
  const unique = (lines: string[]) => {
    let matches = 0
    for (let index = 0; index + context.length <= lines.length; index++) {
      if (
        lines[index] === context[0] &&
        context.every((line, n) => lines[index + n] === line) &&
        ++matches > 1
      )
        return false
    }
    return matches === 1
  }
  return unique(oldLines) && unique(newLines)
    ? { start: start + offset, end: end + offset }
    : undefined
}
