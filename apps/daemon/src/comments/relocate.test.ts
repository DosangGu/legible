import { describe, expect, it } from 'vitest'
import { mapRange } from './relocate.js'

describe('conservative range relocation', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `unique line ${String(i + 1)}`)
  it('maps an unchanged multi-line range after insertions and deletions above it', () => {
    const after = ['new', 'another', ...lines.slice(1)]
    expect(mapRange(lines.join('\n'), after.join('\n'), '@@ -1 +1,2 @@', 9, 11)).toEqual({
      start: 10,
      end: 12,
    })
  })
  it('refuses changed, deleted, or split ranges', () => {
    for (const patch of ['@@ -9 +9 @@', '@@ -9,3 +8,0 @@', '@@ -9,0 +10 @@'])
      expect(mapRange(lines.join('\n'), lines.join('\n'), patch, 9, 11)).toBeUndefined()
  })
  it('refuses ambiguous repeated context and nearby edits', () => {
    expect(mapRange('x\nx\nx\nx\nx\nx\nx\nx', 'x\nx\nx\nx\nx\nx\nx\nx', '', 4, 4)).toBeUndefined()
    const after = [...lines]
    after[7] = 'changed nearby'
    expect(mapRange(lines.join('\n'), after.join('\n'), '@@ -8 +8 @@', 9, 11)).toBeUndefined()
  })
})
