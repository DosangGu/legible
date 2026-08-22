import type { DaemonEventEnvelope, PreflightReport } from '@legible/protocol'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { createSnapshotEvent } from './app.js'
import type { CommandResult, CommandRunner } from '../preflight/command-runner.js'
import { createDaemon, type DaemonRuntime } from '../server.js'
import { ReadyCommandRunner, reviewSession } from '../testing/fixtures.js'

const runtimes: DaemonRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(({ app }) => app.close()))
})

describe('daemon API', () => {
  it('exposes health, preflight, sessions, and stable errors', async () => {
    const runtime = await makeRuntime()

    const health = await runtime.app.inject({ method: 'GET', url: '/api/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ status: 'ready', version: '1.2.3', uptimeSeconds: 0 })

    const preflight = await runtime.app.inject({ method: 'GET', url: '/api/preflight' })
    expect(preflight.json<PreflightReport>().checks).toHaveLength(4)

    const sessions = await runtime.app.inject({ method: 'GET', url: '/api/sessions' })
    expect(sessions.json()).toEqual([])

    const missing = await runtime.app.inject({ method: 'GET', url: '/missing' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({
      error: { code: 'not_found', message: 'Route not found' },
    })
  })

  it('starts degraded and refreshes preflight over HTTP', async () => {
    let authenticated = false
    const runner: CommandRunner = {
      async run(_command, args): Promise<CommandResult> {
        if (args.includes('status') && !authenticated) {
          return { status: 'completed', exitCode: 1, stdout: '', stderr: '' }
        }
        return { status: 'completed', exitCode: 0, stdout: 'version 1', stderr: '' }
      },
    }
    const runtime = await makeRuntime(runner)

    const degraded = await runtime.app.inject({ method: 'GET', url: '/api/health' })
    expect(degraded.json()).toMatchObject({ status: 'degraded' })

    authenticated = true
    const refreshed = await runtime.app.inject({
      method: 'POST',
      url: '/api/preflight/refresh',
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json()).toMatchObject({ status: 'ready' })
  })

  it('creates a snapshot and broadcasts ordered registry and preflight events', async () => {
    const runtime = await makeRuntime()
    const snapshot = createSnapshotEvent(
      runtime.services,
      () => new Date('2026-08-21T03:00:00.000Z'),
    )

    expect(snapshot).toMatchObject({
      type: 'daemon.snapshot',
      sequence: 1,
      payload: { sessions: [], preflight: { status: 'ready' } },
    })

    const { socket, snapshot: streamedSnapshot } = await connectEvents(runtime.app)
    expect(streamedSnapshot).toEqual(snapshot)
    const sessionEventPromise = nextMessage(socket)
    runtime.services.sessions.add(reviewSession())
    await expect(sessionEventPromise).resolves.toMatchObject({
      type: 'session.added',
      sequence: 2,
      payload: { id: 'session-1' },
    })

    const preflightEventPromise = nextMessage(socket)
    await runtime.app.inject({ method: 'POST', url: '/api/preflight/refresh' })
    await expect(preflightEventPromise).resolves.toMatchObject({
      type: 'preflight.updated',
      sequence: 3,
      payload: { status: 'ready' },
    })

    socket.terminate()
  })

  it('closes clients that send application messages', async () => {
    const runtime = await makeRuntime()
    const { socket } = await connectEvents(runtime.app)
    const closed = new Promise<number>((resolve) => socket.once('close', resolve))

    socket.send('not allowed')

    await expect(closed).resolves.toBe(1008)
  })
})

async function makeRuntime(runner: CommandRunner = new ReadyCommandRunner()) {
  const runtime = await createDaemon({
    version: '1.2.3',
    repoPath: '/repo',
    runner,
    now: () => new Date('2026-08-21T03:00:00.000Z'),
  })
  runtimes.push(runtime)
  return runtime
}

function nextMessage(socket: WebSocket): Promise<DaemonEventEnvelope> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as DaemonEventEnvelope)
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', reject)
  })
}

async function connectEvents(
  app: FastifyInstance,
): Promise<{ socket: WebSocket; snapshot: DaemonEventEnvelope }> {
  let resolveSnapshot!: (event: DaemonEventEnvelope) => void
  let rejectSnapshot!: (error: unknown) => void
  const snapshot = new Promise<DaemonEventEnvelope>((resolve, reject) => {
    resolveSnapshot = resolve
    rejectSnapshot = reject
  })
  const socket = await app.injectWS(
    '/api/events',
    {},
    {
      onInit(client) {
        client.once('message', (data) => {
          try {
            resolveSnapshot(JSON.parse(data.toString()) as DaemonEventEnvelope)
          } catch (error) {
            rejectSnapshot(error)
          }
        })
        client.once('error', rejectSnapshot)
      },
    },
  )

  return { socket, snapshot: await snapshot }
}
