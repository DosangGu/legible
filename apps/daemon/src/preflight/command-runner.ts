import { execFile } from 'node:child_process'

export type CommandResult =
  | { status: 'completed'; exitCode: number; stdout: string; stderr: string }
  | { status: 'missing' }
  | { status: 'timed_out' }
  | { status: 'error' }

export type CommandOptions = {
  timeoutMs: number
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>
}

type ExecFileError = Error & {
  code?: number | string
  killed?: boolean
}

export class NodeCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        command,
        [...args],
        {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: options.timeoutMs,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ status: 'completed', exitCode: 0, stdout, stderr })
            return
          }

          const execError = error as ExecFileError
          if (execError.code === 'ENOENT') {
            resolve({ status: 'missing' })
          } else if (execError.killed) {
            resolve({ status: 'timed_out' })
          } else if (typeof execError.code === 'number') {
            resolve({ status: 'completed', exitCode: execError.code, stdout, stderr })
          } else {
            resolve({ status: 'error' })
          }
        },
      )
    })
  }
}
