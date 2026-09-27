import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DirectoryBrowser } from './directory-browser.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'legible-browser-'))
  const outside = await mkdtemp(join(tmpdir(), 'legible-outside-'))
  roots.push(root, outside)
  const projects = join(root, 'projects')
  const checkout = join(projects, 'checkout')
  await mkdir(join(checkout, '.git'), { recursive: true })
  await mkdir(join(checkout, 'src'))
  await writeFile(join(checkout, 'secret.txt'), 'not a listing')
  for (const name of ['.hidden', 'node_modules', 'target']) await mkdir(join(root, name))
  await writeFile(join(root, 'visible.txt'), 'not a directory')
  await symlink(outside, join(root, 'outside-link'))
  await symlink(projects, join(root, 'inside-link'))
  return { root, outside, projects, checkout, browser: new DirectoryBrowser(root) }
}

describe('DirectoryBrowser', () => {
  it('lists directories only, hides excluded names and symlinks, and stops at a Git marker', async () => {
    const f = await fixture()
    expect(await f.browser.list()).toMatchObject({
      root: f.root,
      path: f.root,
      repository: false,
      entries: [{ name: 'projects', path: f.projects, repository: false }],
    })
    expect(await f.browser.list(f.projects)).toMatchObject({
      parent: f.root,
      entries: [{ name: 'checkout', path: f.checkout, repository: true }],
    })
    expect(await f.browser.list(f.checkout)).toMatchObject({
      repository: true,
      entries: [],
    })
    await expect(f.browser.list(join(f.checkout, 'src'))).rejects.toMatchObject({
      code: 'directory_repository_leaf',
    })
    await expect(f.browser.list(join(f.checkout, '.git'))).rejects.toMatchObject({
      code: 'directory_hidden',
    })
    const linked = join(f.projects, 'linked')
    await mkdir(linked)
    await writeFile(join(linked, '.git'), 'gitdir: elsewhere')
    expect((await f.browser.list(f.projects)).entries).toEqual(
      expect.arrayContaining([{ name: 'linked', path: linked, repository: true }]),
    )
    expect((await f.browser.list(linked)).entries).toEqual([])
  })

  it('rejects escapes and excluded direct paths after canonicalization', async () => {
    const f = await fixture()
    for (const path of [
      f.outside,
      join(f.root, 'outside-link'),
      join(f.root, '..', f.outside.split('/').at(-1)!),
    ]) {
      await expect(f.browser.list(path)).rejects.toMatchObject({ code: 'directory_forbidden' })
    }
    for (const name of ['.hidden', 'node_modules', 'target'])
      await expect(f.browser.list(join(f.root, name))).rejects.toMatchObject({
        code: 'directory_hidden',
      })
    await expect(f.browser.list('projects')).rejects.toMatchObject({
      code: 'invalid_directory_path',
    })
    await expect(f.browser.list('')).rejects.toMatchObject({ code: 'invalid_directory_path' })
    await expect(f.browser.list(join(f.root, 'visible.txt'))).rejects.toMatchObject({
      code: 'directory_unavailable',
    })
    expect((await f.browser.list(join(f.root, 'inside-link'))).path).toBe(f.projects)
  })

  it('bounds large listings and marks incomplete results', async () => {
    const f = await fixture()
    await Promise.all(
      Array.from({ length: 220 }, (_, index) =>
        mkdir(join(f.root, `folder-${String(index).padStart(3, '0')}`)),
      ),
    )
    const listing = await f.browser.list()
    expect(listing.entries).toHaveLength(200)
    expect(listing.truncated).toBe(true)
    expect(
      listing.entries.every(
        (entry) => entry.name.startsWith('folder-') || entry.name === 'projects',
      ),
    ).toBe(true)
  })
})
