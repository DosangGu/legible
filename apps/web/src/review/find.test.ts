import { describe, expect, it } from 'vitest'
import { findText } from './find.js'

describe('literal text search', () => {
  it('uses real UTF-16 offsets and treats regex characters literally', () => {
    expect(findText('🙂 한글 .*\n.*', '.*')).toEqual({
      matches: [
        { from: 6, to: 8 },
        { from: 9, to: 11 },
      ],
      truncated: false,
    })
    expect(findText('Alpha alpha', 'alpha').matches).toEqual([{ from: 6, to: 11 }])
  })
  it('bounds matches and rejects empty or multiline queries', () => {
    expect(findText('x'.repeat(1001), 'x')).toMatchObject({ truncated: true })
    expect(findText('x'.repeat(1001), 'x').matches).toHaveLength(1000)
    expect(findText('text', '').matches).toEqual([])
    expect(findText('text', 'a\nb').matches).toEqual([])
  })
})
