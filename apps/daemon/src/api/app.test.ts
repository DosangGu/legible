import type { DaemonEventEnvelope, PreflightReport } from '@legible/protocol'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { createSnapshotEvent } from './app.js'
import type { AgentBackend } from '../agents/types.js'
import { GitFileSourceError, type FileSource } from '../diffs/file-source.js'
import { GitDiffSourceError, type DiffSource } from '../diffs/source.js'
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

  it('keeps serving when the best-effort startup worktree sweep fails', async () => {
    const runner: CommandRunner = {
      async run(_command, args): Promise<CommandResult> {
        if (args.includes('rev-parse')) {
          return { status: 'completed', exitCode: 128, stdout: '', stderr: 'not a repository' }
        }
        return { status: 'completed', exitCode: 0, stdout: 'version 1', stderr: '' }
      },
    }

    const runtime = await makeRuntime(runner)
    const health = await runtime.app.inject({ method: 'GET', url: '/api/health' })

    expect(health.statusCode).toBe(200)
    expect(health.json()).toMatchObject({ status: 'ready' })
  })

  it('returns a normalized diff for a registered session', async () => {
    const source = diffSourceFrom([
      'diff --git a/example.ts b/example.ts',
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ])
    const runtime = await makeRuntime(new ReadyCommandRunner(), source)
    runtime.services.sessions.add(
      reviewSession({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }),
    )

    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/diff',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      additions: 1,
      deletions: 1,
      files: [{ oldPath: 'example.ts', newPath: 'example.ts' }],
    })
  })

  it('returns stable errors for missing sessions and unavailable diffs', async () => {
    const source: DiffSource = {
      async *read() {
        yield ''
        throw new GitDiffSourceError('missing object', 128)
      },
    }
    const runtime = await makeRuntime(new ReadyCommandRunner(), source)

    const missing = await runtime.app.inject({
      method: 'GET',
      url: '/api/sessions/missing/diff',
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({
      error: { code: 'session_not_found', message: 'Review session not found' },
    })

    runtime.services.sessions.add(
      reviewSession({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }),
    )
    const unavailable = await runtime.app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/diff',
    })
    expect(unavailable.statusCode).toBe(409)
    expect(unavailable.json()).toEqual({
      error: { code: 'diff_unavailable', message: 'Diff unavailable for this session' },
    })
  })

  it('returns whole-file content only for a path and side in the session diff', async () => {
    const fileSource: FileSource = {
      async read(input) {
        expect(input).toEqual({
          cwd: '/state/worktrees/owner/repo/pr-42',
          sha: 'b'.repeat(40),
          path: 'example.ts',
        })
        return new TextEncoder().encode('after\n')
      },
    }
    const runtime = await makeRuntime(
      new ReadyCommandRunner(),
      diffSourceFrom(exampleDiff),
      fileSource,
    )
    runtime.services.sessions.add(
      reviewSession({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }),
    )

    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/file?path=example.ts&side=RIGHT',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      path: 'example.ts',
      side: 'RIGHT',
      sha: 'b'.repeat(40),
      content: 'after\n',
      isBinary: false,
      byteLength: 6,
    })

    const unauthorized = await runtime.app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/file?path=.git%2Fconfig&side=RIGHT',
    })
    expect(unauthorized.statusCode).toBe(404)
    expect(unauthorized.json()).toMatchObject({ error: { code: 'file_not_found' } })

    const wrongSide = await runtime.app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/file?path=example.ts&side=MIDDLE',
    })
    expect(wrongSide.statusCode).toBe(400)
    expect(wrongSide.json()).toMatchObject({ error: { code: 'invalid_file_request' } })
  })

  it('returns a stable error when a reviewed file cannot be read', async () => {
    const fileSource: FileSource = {
      async read() {
        throw new GitFileSourceError('missing object', 128)
      },
    }
    const runtime = await makeRuntime(
      new ReadyCommandRunner(),
      diffSourceFrom(exampleDiff),
      fileSource,
    )
    runtime.services.sessions.add(
      reviewSession({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }),
    )

    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/file?path=example.ts&side=RIGHT',
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: { code: 'file_unavailable', message: 'File unavailable for this session' },
    })
  })

  it('treats malformed Git output as an internal parser error', async () => {
    const runtime = await makeRuntime(
      new ReadyCommandRunner(),
      diffSourceFrom(['diff --git a/example.ts b/example.ts', '@@ -1,2 +1,2 @@', ' one']),
    )
    runtime.services.sessions.add(
      reviewSession({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }),
    )

    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/diff',
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    })
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

  it('starts main chat over HTTP and streams revisioned events', async () => {
    const codex: AgentBackend = {
      async start() {
        return {
          async *send() {
            yield { type: 'assistant_delta' as const, text: 'Review complete.' }
            yield { type: 'turn_completed' as const }
          },
          async interrupt() {},
          async close() {},
        }
      },
    }
    const runtime = await makeRuntime(
      new ReadyCommandRunner(),
      diffSourceFrom(exampleDiff),
      undefined,
      codex,
    )
    runtime.services.sessions.add(
      reviewSession({
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        config: {
          main: {
            backend: 'codex',
            shell: 'git',
            network: 'fetch',
            onOutOfScope: 'deny',
          },
        },
      }),
    )
    const { socket } = await connectEvents(runtime.app)
    const streamed = nextMessage(socket)

    const started = await runtime.app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/chat/start',
    })

    expect(started.statusCode).toBe(202)
    await expect(streamed).resolves.toMatchObject({
      type: 'chat.event',
      payload: { sessionId: 'session-1', revision: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const snapshot = await runtime.app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/chat',
    })
    expect(snapshot.json()).toMatchObject({
      status: 'idle',
      entries: [
        { kind: 'message', role: 'user' },
        { kind: 'message', role: 'assistant', text: 'Review complete.' },
      ],
    })
    socket.terminate()
  })
})

async function makeRuntime(
  runner: CommandRunner = new ReadyCommandRunner(),
  diffSource?: DiffSource,
  fileSource?: FileSource,
  codexBackend?: AgentBackend,
) {
  const runtime = await createDaemon({
    version: '1.2.3',
    repoPath: '/repo',
    runner,
    ...(diffSource ? { diffSource } : {}),
    ...(fileSource ? { fileSource } : {}),
    ...(codexBackend ? { codexBackend } : {}),
    now: () => new Date('2026-08-21T03:00:00.000Z'),
  })
  runtimes.push(runtime)
  return runtime
}

const exampleDiff = [
  'diff --git a/example.ts b/example.ts',
  '--- a/example.ts',
  '+++ b/example.ts',
  '@@ -1 +1 @@',
  '-before',
  '+after',
]

function diffSourceFrom(lines: readonly string[]): DiffSource {
  return {
    async *read() {
      for (const line of lines) yield line
    },
  }
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
