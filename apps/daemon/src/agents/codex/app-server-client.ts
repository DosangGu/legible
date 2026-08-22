import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

type RequestId = number

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

type RpcErrorBody = {
  code?: unknown
  message?: unknown
  data?: unknown
}

type InboundMessage = {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

export type AppServerNotification = {
  method: string
  params: unknown
}

export type AppServerRequest = {
  method: string
  params: unknown
}

export type AppServerRequestHandler = (request: AppServerRequest) => Promise<unknown>

export interface AppServerProcess {
  stdin: Pick<Writable, 'write' | 'end'>
  stdout: Readable
  stderr: Readable
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

export type AppServerProcessFactory = () => AppServerProcess

export type AppServerClientOptions = {
  requestTimeoutMs?: number
  stderrLimit?: number
}

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'AppServerRpcError'
  }
}

export class AppServerTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppServerTransportError'
  }
}

export class AppServerClient {
  readonly #pending = new Map<RequestId, PendingRequest>()
  readonly #notifications = new Set<(notification: AppServerNotification) => void>()
  readonly #errors = new Set<(error: AppServerTransportError) => void>()
  readonly #requestTimeoutMs: number
  readonly #stderrLimit: number
  readonly #process: AppServerProcess
  readonly #lines: ReturnType<typeof createInterface>
  readonly #exitPromise: Promise<void>
  #requestHandler: AppServerRequestHandler = async ({ method }) => {
    throw new AppServerRpcError(`Unsupported server request: ${method}`, -32_601)
  }
  #nextId = 1
  #stderr = ''
  #closed = false

  constructor(process: AppServerProcess, options: AppServerClientOptions = {}) {
    this.#process = process
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.#stderrLimit = options.stderrLimit ?? 16_384
    let resolveExit: () => void = () => undefined
    this.#exitPromise = new Promise((resolve) => {
      resolveExit = resolve
    })
    this.#lines = createInterface({ input: process.stdout })
    this.#lines.on('line', (line) => this.#receive(line))
    process.stderr.setEncoding('utf8')
    process.stderr.on('data', (chunk: string) => this.#captureStderr(chunk))
    process.once('error', (error) => {
      resolveExit()
      this.#fail(new AppServerTransportError(error.message, { cause: error }))
    })
    process.once('exit', (code, signal) => {
      resolveExit()
      const detail = signal ? `signal ${signal}` : `code ${String(code)}`
      this.#fail(
        new AppServerTransportError(
          `Codex app-server exited with ${detail}${this.#stderrSuffix()}`,
        ),
      )
    })
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(new AppServerTransportError('App-server is closed'))

    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new AppServerTransportError(`App-server request timed out: ${method}`))
      }, this.#requestTimeoutMs)
      this.#pending.set(id, { resolve, reject, timeout })
      try {
        this.#write({ id, method, params })
      } catch (error) {
        clearTimeout(timeout)
        this.#pending.delete(id)
        reject(
          new AppServerTransportError(`Failed to send app-server request: ${method}`, {
            cause: error,
          }),
        )
      }
    })
  }

  notify(method: string, params: unknown = {}): void {
    if (this.#closed) throw new AppServerTransportError('App-server is closed')
    this.#write({ method, params })
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.#notifications.add(listener)
    return () => this.#notifications.delete(listener)
  }

  onError(listener: (error: AppServerTransportError) => void): () => void {
    this.#errors.add(listener)
    return () => this.#errors.delete(listener)
  }

  handleRequests(handler: AppServerRequestHandler): void {
    this.#requestHandler = handler
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#lines.close()
    this.#process.stdin.end()
    this.#rejectPending(new AppServerTransportError('App-server closed'))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    return this.#process.kill(signal)
  }

  waitForExit(): Promise<void> {
    return this.#exitPromise
  }

  #receive(line: string): void {
    let message: InboundMessage
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) throw new Error('message must be an object')
      message = parsed
    } catch (error) {
      this.#fail(
        new AppServerTransportError('Invalid JSON from Codex app-server', { cause: error }),
      )
      return
    }

    if (typeof message.id === 'number' && typeof message.method === 'string') {
      void this.#handleServerRequest(message.id, message.method, message.params)
      return
    }

    if (typeof message.id === 'number') {
      this.#handleResponse(message.id, message.result, message.error)
      return
    }

    if (typeof message.method === 'string') {
      const notification = { method: message.method, params: message.params }
      for (const listener of [...this.#notifications]) listener(notification)
      return
    }

    this.#fail(new AppServerTransportError('Unrecognized message from Codex app-server'))
  }

  #handleResponse(id: number, result: unknown, error: unknown): void {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timeout)

    if (error !== undefined) {
      const body = isRecord(error) ? (error as RpcErrorBody) : undefined
      pending.reject(
        new AppServerRpcError(
          typeof body?.message === 'string' ? body.message : 'Codex app-server request failed',
          typeof body?.code === 'number' ? body.code : undefined,
          body?.data,
        ),
      )
      return
    }

    pending.resolve(result)
  }

  async #handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.#requestHandler({ method, params })
      this.#write({ id, result })
    } catch (error) {
      const rpcError = error instanceof AppServerRpcError ? error : undefined
      this.#write({
        id,
        error: {
          code: rpcError?.code ?? -32_000,
          message: error instanceof Error ? error.message : 'Server request rejected',
          ...(rpcError?.data !== undefined ? { data: rpcError.data } : {}),
        },
      })
    }
  }

  #write(message: unknown): void {
    this.#process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #captureStderr(chunk: string): void {
    this.#stderr = `${this.#stderr}${chunk}`.slice(-this.#stderrLimit)
  }

  #stderrSuffix(): string {
    const stderr = this.#stderr.trim()
    return stderr ? `: ${stderr}` : ''
  }

  #fail(error: AppServerTransportError): void {
    if (this.#closed) return
    this.#closed = true
    this.#lines.close()
    this.#rejectPending(error)
    for (const listener of [...this.#errors]) listener(error)
  }

  #rejectPending(error: AppServerTransportError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

export function spawnCodexAppServer(): AppServerProcess {
  return spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
