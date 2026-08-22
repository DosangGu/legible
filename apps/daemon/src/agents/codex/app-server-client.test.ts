import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  AppServerClient,
  AppServerRpcError,
  AppServerTransportError,
  type AppServerProcess,
} from './app-server-client.js'

describe('AppServerClient', () => {
  it('correlates out-of-order responses and publishes notifications', async () => {
    const process = new FakeProcess()
    const client = new AppServerClient(process)
    const notifications: unknown[] = []
    client.onNotification((notification) => notifications.push(notification))

    const first = client.request('first')
    const second = client.request('second')
    const sent = process.readRequests()

    process.send({ id: sent[1]?.id, result: { order: 2 } })
    process.send({ method: 'turn/started', params: { turnId: 'turn-1' } })
    process.send({ id: sent[0]?.id, result: { order: 1 } })

    await expect(first).resolves.toEqual({ order: 1 })
    await expect(second).resolves.toEqual({ order: 2 })
    expect(notifications).toEqual([{ method: 'turn/started', params: { turnId: 'turn-1' } }])
  })

  it('returns normalized RPC failures and server-request responses', async () => {
    const process = new FakeProcess()
    const client = new AppServerClient(process)
    client.handleRequests(async ({ method }) => {
      if (method === 'allowed') return { ok: true }
      throw new AppServerRpcError('denied', -32_000)
    })

    const failed = client.request('fails')
    const request = process.readRequests()[0]
    process.send({ id: request?.id, error: { code: 42, message: 'bad request' } })
    await expect(failed).rejects.toMatchObject({
      name: 'AppServerRpcError',
      code: 42,
      message: 'bad request',
    })

    process.send({ id: 90, method: 'allowed', params: {} })
    process.send({ id: 91, method: 'blocked', params: {} })
    await vi.waitFor(() => {
      expect(process.readRequests()).toEqual(
        expect.arrayContaining([
          { id: 90, result: { ok: true } },
          { id: 91, error: { code: -32_000, message: 'denied' } },
        ]),
      )
    })
  })

  it('fails pending work on malformed JSON, timeout, and process exit', async () => {
    const malformedProcess = new FakeProcess()
    const malformed = new AppServerClient(malformedProcess)
    const malformedRequest = malformed.request('waiting')
    malformedProcess.stdout.write('{not json}\n')
    await expect(malformedRequest).rejects.toBeInstanceOf(AppServerTransportError)

    const timeoutProcess = new FakeProcess()
    const timeout = new AppServerClient(timeoutProcess, { requestTimeoutMs: 5 })
    await expect(timeout.request('slow')).rejects.toThrow('timed out')

    const exitProcess = new FakeProcess()
    const exited = new AppServerClient(exitProcess)
    const exitRequest = exited.request('waiting')
    exitProcess.stderr.write('details')
    exitProcess.exit(7)
    await expect(exitRequest).rejects.toThrow('code 7: details')
  })
})

class FakeProcess extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  #buffer = ''

  constructor() {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.#buffer += chunk
    })
  }

  readRequests(): Array<Record<string, unknown>> {
    return this.#buffer
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.exit(null, signal)
    return true
  }
}
