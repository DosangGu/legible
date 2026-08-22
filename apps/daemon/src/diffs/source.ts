import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export type GitDiffInput = {
  cwd: string
  baseSha: string
  headSha: string
}

export interface DiffSource {
  read(input: GitDiffInput): AsyncIterable<string>
}

export class GitDiffSourceError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
  ) {
    super(message)
    this.name = 'GitDiffSourceError'
  }
}

export class NodeGitDiffSource implements DiffSource {
  async *read(input: GitDiffInput): AsyncIterable<string> {
    const child = spawn('git', buildGitDiffArgs(input.baseSha, input.headSha), {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stderr.setEncoding('utf8')
    let stderr = ''
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_192)
    })

    const completion = new Promise<{ exitCode: number; error?: GitDiffSourceError }>((resolve) => {
      child.once('error', (error) =>
        resolve({ exitCode: 1, error: new GitDiffSourceError(error.message) }),
      )
      child.once('close', (code) => resolve({ exitCode: code ?? 1 }))
    })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    let completed = false

    try {
      for await (const line of lines) yield line
      const result = await completion
      completed = true
      if (result.error) throw result.error
      if (result.exitCode !== 0) {
        const detail = stderr.trim()
        throw new GitDiffSourceError(detail || 'git diff failed', result.exitCode)
      }
    } finally {
      lines.close()
      if (!completed && child.exitCode === null) {
        child.kill()
        await completion
      }
    }
  }
}

export function buildGitDiffArgs(baseSha: string, headSha: string): string[] {
  return [
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    `${baseSha}...${headSha}`,
    '--',
  ]
}
