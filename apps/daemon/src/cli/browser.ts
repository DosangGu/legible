import { execFile } from 'node:child_process'
import { release } from 'node:os'
import type { CliCommand } from './arguments.js'

export function shouldOpenBrowser(
  mode: CliCommand['browser'],
  tty: boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  if (mode !== 'auto') return mode === 'open'
  return tty && !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY && !env.CI
}

export function browserCommand(platform: string, kernel: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return 'open'
  if (platform === 'linux')
    return env.WSL_DISTRO_NAME || /microsoft/iu.test(kernel) ? 'wslview' : 'xdg-open'
  throw new Error('Native Windows is not supported; use WSL')
}

export async function openBrowser(url: string): Promise<void> {
  const command = browserCommand(process.platform, release(), process.env)
  await new Promise<void>((resolve, reject) => {
    execFile(command, [url], { timeout: 5_000, maxBuffer: 64 * 1024 }, (error) => {
      // execFile errors include argv; never expose the URL secret through diagnostics.
      if (error) reject(new Error(`Unable to open browser with ${command}; use the printed URL`))
      else resolve()
    })
  })
}
