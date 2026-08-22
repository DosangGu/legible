import type { DiffFile, ReviewFileContent } from '@legible/protocol'
import { describe, expect, it } from 'vitest'

import {
  buildDiffRenderModel,
  buildWholeFileRenderModel,
  defaultFileTarget,
} from './render-model.js'
import { diffDocument } from '../testing/fixtures.js'

describe('diff render model', () => {
  it('maps unified document lines to LEFT and RIGHT anchors and file sections', () => {
    const model = buildDiffRenderModel(diffDocument())

    expect(model.document).toContain('MODIFIED  src/a.ts → src/a.ts  +1 −1')
    expect(model.files).toEqual([
      expect.objectContaining({ index: 0, path: 'src/a.ts', startLine: 1 }),
      expect.objectContaining({ index: 1, path: 'new.txt' }),
    ])
    expect(model.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'context',
          leftAnchor: { path: 'src/a.ts', line: 1, side: 'LEFT' },
          rightAnchor: { path: 'src/a.ts', line: 1, side: 'RIGHT' },
        }),
        expect.objectContaining({
          kind: 'deletion',
          leftAnchor: { path: 'src/a.ts', line: 2, side: 'LEFT' },
        }),
        expect.objectContaining({
          kind: 'addition',
          rightAnchor: { path: 'src/a.ts', line: 2, side: 'RIGHT' },
        }),
      ]),
    )
  })

  it('builds whole-file anchors, highlights changed lines, and skips a trailing phantom line', () => {
    const file = diffDocument().files[0]
    if (!file) throw new Error('missing fixture file')
    const content: ReviewFileContent = {
      path: 'src/a.ts',
      side: 'RIGHT',
      sha: 'b'.repeat(40),
      content: 'one\nafter\nthree\n',
      isBinary: false,
      byteLength: 16,
    }

    const model = buildWholeFileRenderModel(content, file)

    expect(model.lines[1]).toMatchObject({
      changed: true,
      rightAnchor: { path: 'src/a.ts', line: 2, side: 'RIGHT' },
    })
    expect(model.lines.at(-1)).toEqual({ kind: 'whole' })
  })

  it('chooses the available side for added and deleted files', () => {
    expect(defaultFileTarget(diffDocument().files[1] as DiffFile)).toEqual({
      path: 'new.txt',
      side: 'RIGHT',
    })
    expect(
      defaultFileTarget({
        oldPath: 'gone.txt',
        newPath: null,
        status: 'deleted',
        isBinary: false,
        additions: 0,
        deletions: 1,
        hunks: [],
      }),
    ).toEqual({ path: 'gone.txt', side: 'LEFT' })
  })
})
