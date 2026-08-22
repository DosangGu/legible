import type { DiffDocument } from '@legible/protocol'

export function diffDocument(): DiffDocument {
  return {
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    additions: 2,
    deletions: 1,
    files: [
      {
        oldPath: 'src/a.ts',
        newPath: 'src/a.ts',
        status: 'modified',
        isBinary: false,
        additions: 1,
        deletions: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 3,
            lines: [
              {
                kind: 'context',
                content: 'one',
                leftLine: 1,
                rightLine: 1,
                noNewlineAtEnd: false,
              },
              {
                kind: 'deletion',
                content: 'before',
                leftLine: 2,
                rightLine: null,
                noNewlineAtEnd: false,
              },
              {
                kind: 'addition',
                content: 'after',
                leftLine: null,
                rightLine: 2,
                noNewlineAtEnd: false,
              },
              {
                kind: 'context',
                content: 'three',
                leftLine: 3,
                rightLine: 3,
                noNewlineAtEnd: false,
              },
            ],
          },
        ],
      },
      {
        oldPath: null,
        newPath: 'new.txt',
        status: 'added',
        isBinary: false,
        additions: 1,
        deletions: 0,
        hunks: [],
      },
    ],
  }
}
