import { spawn } from 'node:child_process'
import { ServiceError } from '../common/service-error.js'

export type GitReadOptions = {
  cwd: string
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal | undefined
  /** Returning false stops a bounded streaming read once enough results have arrived. */
  onChunk?(chunk: Buffer): boolean
}
export type GitReadResult = { bytes: Buffer; limited: boolean; exitCode: number }
export type GitReader = (args: string[], options: GitReadOptions) => Promise<GitReadResult>

/** No shell, pager, filters, or lazy network fetches; bounded output and child lifetime. */
export const readGit: GitReader = (args, options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(aborted())
      return
    }
    const child = spawn('git', ['--no-pager', '--literal-pathspecs', ...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let limited = false
    let failure: Error | undefined
    const stop = () => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    const abort = () => {
      failure = aborted()
      stop()
    }
    const timer = setTimeout(
      () => {
        limited = true
        stop()
      },
      Math.max(1, options.timeoutMs),
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stderr.resume()
    child.stdout.on('data', (chunk: Buffer) => {
      if (limited || failure) return
      const accepted = chunk.subarray(0, Math.max(0, options.maxBytes - bytes))
      bytes += accepted.length
      if (!options.onChunk) chunks.push(accepted)
      try {
        if (options.onChunk?.(accepted) === false || accepted.length < chunk.length) {
          limited = true
          stop()
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Invalid Git output')
        stop()
      }
    })
    child.once('error', () => {
      failure = new ServiceError('search_unavailable', 'Git search is unavailable', 409)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else resolve({ bytes: Buffer.concat(chunks), limited, exitCode: code ?? 1 })
    })
  })

function aborted() {
  return new ServiceError('search_cancelled', 'Search cancelled', 499)
}
