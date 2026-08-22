import { spawn } from 'node:child_process'

export type GitFileInput = {
  cwd: string
  sha: string
  path: string
}

export interface FileSource {
  read(input: GitFileInput): Promise<Uint8Array>
}

export class GitFileSourceError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
  ) {
    super(message)
    this.name = 'GitFileSourceError'
  }
}

export class NodeGitFileSource implements FileSource {
  read(input: GitFileInput): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['show', `${input.sha}:${input.path}`], {
        cwd: input.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const chunks: Uint8Array[] = []
      let stderr = ''

      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_192)
      })
      child.once('error', (error) => reject(new GitFileSourceError(error.message)))
      child.once('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks))
        } else {
          reject(new GitFileSourceError(stderr.trim() || 'git show failed', code ?? 1))
        }
      })
    })
  }
}
