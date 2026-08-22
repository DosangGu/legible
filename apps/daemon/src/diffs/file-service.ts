import type { DiffSide, ReviewFileContent, ReviewSession } from '@legible/protocol'

import { DiffUnavailableError, SessionDiffService } from './service.js'
import { GitFileSourceError, type FileSource } from './file-source.js'

export class ReviewFileNotFoundError extends Error {
  constructor(path: string, side: DiffSide) {
    super(`File is not part of the session diff on ${side}: ${path}`)
    this.name = 'ReviewFileNotFoundError'
  }
}

export class ReviewFileUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ReviewFileUnavailableError'
  }
}

export class SessionFileService {
  constructor(
    private readonly diffs: SessionDiffService,
    private readonly source: FileSource,
  ) {}

  async get(session: ReviewSession, path: string, side: DiffSide): Promise<ReviewFileContent> {
    let document
    try {
      document = await this.diffs.get(session)
    } catch (error) {
      if (error instanceof DiffUnavailableError) {
        throw new ReviewFileUnavailableError('Session diff is unavailable', { cause: error })
      }
      throw error
    }

    const file = document.files.find((candidate) =>
      side === 'LEFT' ? candidate.oldPath === path : candidate.newPath === path,
    )
    if (!file) throw new ReviewFileNotFoundError(path, side)

    const sha = side === 'LEFT' ? session.baseSha : session.headSha
    let bytes: Uint8Array
    try {
      bytes = await this.source.read({ cwd: session.worktreePath, sha, path })
    } catch (error) {
      if (error instanceof GitFileSourceError) {
        throw new ReviewFileUnavailableError('Git blob is unavailable', { cause: error })
      }
      throw error
    }

    const isBinary = bytes.includes(0)
    return {
      path,
      side,
      sha,
      content: isBinary ? null : new TextDecoder().decode(bytes),
      isBinary,
      byteLength: bytes.byteLength,
    }
  }
}
