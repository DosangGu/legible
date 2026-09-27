import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it } from 'vitest'
import { createCanonicalTempDirectory } from './temp-directory.js'

it('returns a canonical path when the temporary parent is a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legible-temp-directory-'))
  try {
    const parent = join(root, 'parent')
    const alias = join(root, 'alias')
    await mkdir(parent)
    await symlink(parent, alias, 'dir')

    const directory = await createCanonicalTempDirectory('child-', alias)

    expect(directory).toBe(join(await realpath(parent), basename(directory)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
