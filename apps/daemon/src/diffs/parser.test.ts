import { describe, expect, it } from 'vitest'

import { DiffParseError, parseUnifiedDiff } from './parser.js'

const baseSha = 'a'.repeat(40)
const headSha = 'b'.repeat(40)

describe('parseUnifiedDiff', () => {
  it('tracks both line counters and no-newline markers across multiple hunks', () => {
    const document = parseUnifiedDiff(
      [
        'diff --git a/src/example.ts b/src/example.ts',
        'index 1111111..2222222 100644',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -10,3 +10,4 @@ function example()',
        ' unchanged',
        '-before',
        '+after',
        '+extra',
        '\\ No newline at end of file',
        ' trailing',
        '@@ -30 +31 @@ second',
        '-old',
        '+new',
      ].join('\n'),
      baseSha,
      headSha,
    )

    expect(document).toMatchObject({ baseSha, headSha, additions: 3, deletions: 2 })
    expect(document.files).toHaveLength(1)
    expect(document.files[0]).toMatchObject({
      oldPath: 'src/example.ts',
      newPath: 'src/example.ts',
      status: 'modified',
      additions: 3,
      deletions: 2,
    })
    expect(document.files[0]?.hunks[0]?.lines).toEqual([
      {
        kind: 'context',
        content: 'unchanged',
        leftLine: 10,
        rightLine: 10,
        noNewlineAtEnd: false,
      },
      {
        kind: 'deletion',
        content: 'before',
        leftLine: 11,
        rightLine: null,
        noNewlineAtEnd: false,
      },
      {
        kind: 'addition',
        content: 'after',
        leftLine: null,
        rightLine: 11,
        noNewlineAtEnd: false,
      },
      {
        kind: 'addition',
        content: 'extra',
        leftLine: null,
        rightLine: 12,
        noNewlineAtEnd: true,
      },
      {
        kind: 'context',
        content: 'trailing',
        leftLine: 12,
        rightLine: 13,
        noNewlineAtEnd: false,
      },
    ])
  })

  it('normalizes added, deleted, renamed, binary, and mode-only files', () => {
    const document = parseUnifiedDiff(
      [
        'diff --git a/new file.txt b/new file.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new file.txt\t',
        '@@ -0,0 +1,2 @@',
        '+hello',
        '+world',
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
        'diff --git a/old name.txt b/new name.txt',
        'similarity index 100%',
        'rename from old name.txt',
        'rename to new name.txt',
        'diff --git a/image.png b/image.png',
        'new file mode 100644',
        'index 0000000..1234567',
        'Binary files /dev/null and b/image.png differ',
        'diff --git a/script.sh b/script.sh',
        'old mode 100644',
        'new mode 100755',
      ].join('\n'),
      baseSha,
      headSha,
    )

    expect(document.files).toEqual([
      expect.objectContaining({
        oldPath: null,
        newPath: 'new file.txt',
        status: 'added',
        newMode: '100644',
        additions: 2,
      }),
      expect.objectContaining({
        oldPath: 'gone.txt',
        newPath: null,
        status: 'deleted',
        oldMode: '100644',
        deletions: 1,
      }),
      expect.objectContaining({
        oldPath: 'old name.txt',
        newPath: 'new name.txt',
        status: 'renamed',
      }),
      expect.objectContaining({
        oldPath: null,
        newPath: 'image.png',
        status: 'added',
        isBinary: true,
      }),
      expect.objectContaining({
        oldPath: 'script.sh',
        newPath: 'script.sh',
        status: 'modified',
        oldMode: '100644',
        newMode: '100755',
        hunks: [],
      }),
    ])
  })

  it('preserves Unicode Git paths', () => {
    const document = parseUnifiedDiff(
      [
        'diff --git a/문서 파일.md b/문서 파일.md',
        '--- a/문서 파일.md\t',
        '+++ b/문서 파일.md\t',
        '@@ -1 +1 @@',
        '-이전',
        '+이후',
      ].join('\n'),
      baseSha,
      headSha,
    )

    expect(document.files[0]).toMatchObject({
      oldPath: '문서 파일.md',
      newPath: '문서 파일.md',
    })
  })

  it('returns an empty document for an empty diff', () => {
    expect(parseUnifiedDiff('', baseSha, headSha)).toEqual({
      baseSha,
      headSha,
      additions: 0,
      deletions: 0,
      files: [],
    })
  })

  it('rejects malformed hunk headers and mismatched line counts', () => {
    expect(() =>
      parseUnifiedDiff(
        ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ malformed'].join('\n'),
        baseSha,
        headSha,
      ),
    ).toThrow(DiffParseError)

    expect(() =>
      parseUnifiedDiff(
        ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,2 @@', ' only one'].join('\n'),
        baseSha,
        headSha,
      ),
    ).toThrow('hunk declared -2/+2 lines but consumed -1/+1')
  })
})
