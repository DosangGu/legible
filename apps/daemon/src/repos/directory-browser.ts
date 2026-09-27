import { lstat, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { DirectoryEntry, DirectoryListing } from '@legible/protocol'

import { ServiceError } from '../common/service-error.js'

const maxEntries = 200
const maxScanned = 2_000
const maxConcurrent = 4
const excluded = new Set(['node_modules', 'target'])

/** Bounded directory-only navigation beneath the same root as repository registration. */
export class DirectoryBrowser {
  readonly #root: string
  #active = 0

  constructor(browseRoot = process.env.LEGIBLE_BROWSE_ROOT ?? homedir()) {
    this.#root = resolve(browseRoot)
  }

  async list(input?: string): Promise<DirectoryListing> {
    if (
      input !== undefined &&
      (!input || input.length > 4096 || !isAbsolute(input) || input.includes('\0'))
    )
      throw new ServiceError(
        'invalid_directory_path',
        'Choose a directory under the configured browse root',
      )
    if (this.#active >= maxConcurrent)
      throw new ServiceError(
        'directory_browse_busy',
        'Too many directory requests; retry shortly',
        429,
      )
    this.#active += 1
    try {
      return await this.#list(input)
    } finally {
      this.#active -= 1
    }
  }

  async #list(input?: string): Promise<DirectoryListing> {
    let root: string
    let path: string
    try {
      root = await realpath(this.#root)
      path = input === undefined ? root : await realpath(input)
    } catch {
      throw new ServiceError(
        'directory_unavailable',
        'Browse root or directory is unavailable',
        404,
      )
    }
    this.#assertVisible(root, path)
    await this.#assertNoGitAncestor(root, path)
    const parent = path === root ? undefined : dirname(path)
    const repository = await this.#hasGitMarker(path)
    if (repository)
      return {
        root,
        path,
        ...(parent ? { parent } : {}),
        repository,
        entries: [],
        truncated: false,
      }

    const entries: DirectoryEntry[] = []
    let truncated = false
    let directory: Awaited<ReturnType<typeof opendir>>
    try {
      directory = await opendir(path)
    } catch {
      throw new ServiceError('directory_unavailable', 'Unable to open this directory', 404)
    }
    try {
      let scanned = 0
      for await (const entry of directory) {
        scanned += 1
        if (scanned > maxScanned) {
          truncated = true
          break
        }
        if (!entry.isDirectory() || isExcluded(entry.name)) continue
        let child: string
        try {
          child = await realpath(join(path, entry.name))
          this.#assertVisible(root, child)
          const repository = await this.#hasGitMarker(child)
          if (entries.length >= maxEntries) {
            truncated = true
            break
          }
          entries.push({ name: entry.name, path: child, repository })
        } catch {
          // Disappearing, inaccessible, or out-of-root entries are never displayed.
          continue
        }
      }
    } catch {
      throw new ServiceError('directory_unavailable', 'Unable to read this directory', 404)
    }
    // The directory may have been replaced while it was read. Never return its names then.
    try {
      if ((await realpath(path)) !== path) throw new Error('Directory changed')
    } catch {
      throw new ServiceError('directory_changed', 'Directory changed during browsing; retry', 409)
    }
    await this.#assertNoGitAncestor(root, path)
    if (await this.#hasGitMarker(path))
      throw new ServiceError('directory_changed', 'Directory changed during browsing; retry', 409)
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return { root, path, ...(parent ? { parent } : {}), repository, entries, truncated }
  }

  #assertVisible(root: string, path: string): void {
    const part = relative(root, path)
    if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
      throw new ServiceError(
        'directory_forbidden',
        'Directory is outside the configured browse root',
        403,
      )
    if (part.split(sep).some(isExcluded))
      throw new ServiceError('directory_hidden', 'This directory is excluded from browsing', 403)
  }

  async #assertNoGitAncestor(root: string, path: string): Promise<void> {
    if (path === root) return
    let ancestor = dirname(path)
    while (true) {
      if (await this.#hasGitMarker(ancestor))
        throw new ServiceError(
          'directory_repository_leaf',
          'Repository directories cannot be browsed further',
          403,
        )
      if (ancestor === root) return
      ancestor = dirname(ancestor)
    }
  }

  async #hasGitMarker(path: string): Promise<boolean> {
    try {
      await lstat(join(path, '.git'))
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw new ServiceError('directory_unavailable', 'Unable to inspect this directory', 404)
    }
  }
}

function isExcluded(name: string): boolean {
  return name.startsWith('.') || excluded.has(name)
}
