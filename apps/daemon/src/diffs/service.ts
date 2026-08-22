import type { DiffDocument, ReviewSession } from '@legible/protocol'

import { DiffParseError, UnifiedDiffParser } from './parser.js'
import { GitDiffSourceError, type DiffSource } from './source.js'

const revisionPattern = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u

export class DiffUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DiffUnavailableError'
  }
}

export class SessionDiffService {
  constructor(private readonly source: DiffSource) {}

  async get(session: ReviewSession): Promise<DiffDocument> {
    if (!revisionPattern.test(session.baseSha) || !revisionPattern.test(session.headSha)) {
      throw new DiffUnavailableError('Session contains an invalid Git revision')
    }

    const parser = new UnifiedDiffParser(session.baseSha, session.headSha)
    try {
      for await (const line of this.source.read({
        cwd: session.worktreePath,
        baseSha: session.baseSha,
        headSha: session.headSha,
      })) {
        parser.push(line)
      }
      return parser.finish()
    } catch (error) {
      if (error instanceof DiffParseError) throw error
      if (error instanceof GitDiffSourceError) {
        throw new DiffUnavailableError('Git diff is unavailable for this session', { cause: error })
      }
      throw error
    }
  }
}
