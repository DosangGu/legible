import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import * as z from 'zod/v4'
import type { DaemonPhase } from './state.js'

export const controlVersion = 1
const maxBytes = 16 * 1024
const timeoutMs = 2_000
const requestSchema = z
  .object({
    protocol: z.literal(controlVersion),
    method: z.enum(['status', 'connect', 'stop']),
    instanceId: z.string().optional(),
  })
  .strict()
export type ControlRequest = z.infer<typeof requestSchema>
export const statusSchema = z.object({
  protocol: z.literal(controlVersion),
  instanceId: z.string().uuid(),
  pid: z.number().int().positive(),
  version: z.string(),
  phase: z.enum(['starting', 'ready', 'stopping']),
  apiOrigin: z.string(),
  webOrigin: z.string(),
})
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: statusSchema, token: z.string().optional() }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
])
export type ControlStatus = z.infer<typeof statusSchema>
export type ControlResponse = z.infer<typeof responseSchema>

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function socketPath(stateDirectory: string): string {
  const path = join(stateDirectory, 'daemon.sock')
  // Portable sockaddr_un budget, including macOS and the trailing NUL.
  if (Buffer.byteLength(path) > 103)
    throw new Error('Legible state path is too long for a Unix socket')
  return path
}

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw new Error('Legible state directory must be a directory owned by the current user')
  await chmod(directory, 0o700)
}

async function inspectSocket(path: string): Promise<boolean> {
  const parent = await lstat(dirname(path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!parent) return false
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o077
  )
    throw new Error('Unsafe Legible control directory permissions or ownership')
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return false
  if (!info.isSocket() || info.uid !== process.getuid?.())
    throw new Error('Refusing unsafe Legible control socket')
  return true
}

/** No HTTP credentials are accepted here: access is through the private Unix socket. */
export async function controlRequest(
  path: string,
  request: ControlRequest,
): Promise<ControlResponse | undefined> {
  if (!(await inspectSocket(path))) return undefined
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(request.method === 'stop' ? 30_000 : timeoutMs, () =>
      socket.destroy(new Error('Legible control request timed out')),
    )
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > maxBytes) {
        socket.destroy(new Error('Invalid Legible control response'))
        return
      }
      if (!buffer.includes('\n')) return
      try {
        const response = responseSchema.parse(JSON.parse(buffer.split('\n')[0]!))
        resolve(response)
        socket.destroy()
      } catch {
        socket.destroy(
          new Error('Incompatible Legible control protocol; stop the existing daemon manually'),
        )
      }
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(undefined)
      else reject(error)
    })
    socket.once('end', () =>
      reject(new Error('Legible closed its control connection before replying')),
    )
  })
}

export class DaemonControl {
  readonly instanceId = randomUUID()
  #server: Server | undefined
  readonly #connections = new Set<Socket>()
  readonly #stopReplies = new Set<Socket>()
  constructor(
    private readonly options: {
      path: string
      version: string
      apiOrigin: string
      webOrigin: string
      phase: () => DaemonPhase
      token: () => string
      stop: () => boolean
      close: () => Promise<void>
      onError: (error: unknown) => void
    },
  ) {}

  status(): ControlStatus {
    return {
      protocol: controlVersion,
      instanceId: this.instanceId,
      pid: process.pid,
      version: this.options.version,
      phase: this.options.phase(),
      apiOrigin: this.options.apiOrigin,
      webOrigin: this.options.webOrigin,
    }
  }

  /** Caller MUST already own the HTTP listener before reclaiming a stale socket. */
  async listen(): Promise<void> {
    await privateDirectory(dirname(this.options.path))
    if (await inspectSocket(this.options.path)) {
      const previous = await controlRequest(this.options.path, {
        protocol: controlVersion,
        method: 'status',
      })
      if (previous) throw new Error('A Legible daemon already owns this state directory')
      await unlink(this.options.path)
    }
    const server = createServer((socket) => this.#accept(socket))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(this.options.path, 0o600)
    server.on('error', this.options.onError)
  }

  async close(): Promise<void> {
    for (const socket of this.#connections) if (!this.#stopReplies.has(socket)) socket.destroy()
    if (this.#server?.listening && this.#stopReplies.size) {
      // The final stop reply is sent AFTER app.close has reported persistence errors.
      this.#server.close()
    } else if (this.#server?.listening)
      await new Promise<void>((resolve, reject) =>
        this.#server!.close((error) => (error ? reject(error) : resolve())),
      )
  }

  #accept(socket: Socket): void {
    this.#connections.add(socket)
    socket.once('close', () => this.#connections.delete(socket))
    socket.on('error', () => undefined)
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () => socket.destroy())
    let buffer = ''
    let handled = false
    socket.on('data', (chunk: string) => {
      if (handled) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > maxBytes) {
        socket.destroy()
        return
      }
      if (!buffer.includes('\n')) return
      handled = true
      let response: ControlResponse
      let stopping = false
      try {
        const request = requestSchema.parse(JSON.parse(buffer.split('\n')[0]!))
        const status = this.status()
        if (request.method !== 'status' && request.instanceId !== this.instanceId)
          throw new ControlError('instance_changed', 'Legible instance changed; reconnect')
        if (request.method === 'connect' && status.phase !== 'ready')
          throw new ControlError('not_ready', `Legible is ${status.phase}`)
        if (request.method === 'stop') {
          if (!this.options.stop())
            throw new ControlError(
              'busy',
              'Legible has active work or is not ready; wait and retry',
            )
          stopping = true
        }
        response = {
          ok: true,
          status: this.status(),
          ...(request.method === 'connect' ? { token: this.options.token() } : {}),
        }
      } catch (error) {
        response = {
          ok: false,
          code: error instanceof ControlError ? error.code : 'invalid_request',
          message:
            error instanceof ControlError ? error.message : 'Invalid Legible control request',
        }
      }
      if (stopping) {
        this.#stopReplies.add(socket)
        socket.setTimeout(30_000, () => socket.destroy())
        void this.#finishStop(socket)
      } else socket.end(`${JSON.stringify(response)}\n`)
    })
  }

  async #finishStop(socket: Socket): Promise<void> {
    let response: ControlResponse
    try {
      await this.options.close()
      response = { ok: true, status: this.status() }
    } catch (error) {
      this.options.onError(error)
      response = {
        ok: false,
        code: 'shutdown_failed',
        message:
          'Legible stopped with cleanup or persistence errors; check daemon.log before restarting',
      }
    }
    this.#stopReplies.delete(socket)
    socket.end(`${JSON.stringify(response)}\n`)
  }
}
