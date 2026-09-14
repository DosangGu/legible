import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { AgentBackendKind } from '@legible/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDaemon, createDaemon, type DaemonRuntime } from '../server.js'
import { ReadyCommandRunner, reviewSession } from '../testing/fixtures.js'
import { controlRequest, controlVersion, socketPath } from './control.js'
import { daemonStatus, connectDaemon, stopDaemon } from '../cli/connection.js'
import { DaemonClient } from '../cli/run.js'
import { deferred } from '../testing/deferred.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function directory() {
  const root = await mkdtemp('/tmp/legible-life-')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}
async function runtime(directory: string) {
  const result = await startDaemon({
    version: 'test',
    port: 0,
    stateDirectory: directory,
    runner: new ReadyCommandRunner(),
  })
  cleanups.push(() => result.app.close())
  return result
}
async function port(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('No port')
  return address.port
}

describe('Owned daemon lifecycle', () => {
  it('claims the listener and socket before recovery, denies startup traffic, and never recovers a competing instance', async () => {
    const root = await directory()
    const assignedPort = await port()
    const gate = deferred()
    const runner = new ReadyCommandRunner()
    const starting = startDaemon({
      version: 'test',
      port: assignedPort,
      stateDirectory: root,
      runner: {
        async run(command, args) {
          await gate.promise
          return runner.run(command, args)
        },
      },
    })
    let owner: DaemonRuntime | undefined
    try {
      await vi.waitFor(async () => expect((await daemonStatus(root))?.phase).toBe('starting'))
      const response = await fetch(`http://127.0.0.1:${String(assignedPort)}/api/auth`, {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${String(assignedPort)}` },
      })
      expect(response.status).toBe(503)
      const competitor = join(root, 'competitor')
      const run = vi.fn(runner.run.bind(runner))
      await expect(
        startDaemon({
          version: 'test',
          port: assignedPort,
          stateDirectory: competitor,
          runner: { run },
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(run).not.toHaveBeenCalled()
      await expect(stat(competitor)).rejects.toMatchObject({ code: 'ENOENT' })
      const pending = await daemonStatus(root)
      const blocked = await controlRequest(socketPath(root), {
        protocol: controlVersion,
        method: 'connect',
        instanceId: pending!.instanceId,
      })
      expect(blocked).toMatchObject({ ok: false, code: 'not_ready' })
      gate.resolve()
      owner = await starting
      expect((await daemonStatus(root))?.phase).toBe('ready')
    } finally {
      gate.resolve()
      owner ??= await starting
      await owner.app.close()
    }
  })

  it('protects regular files and symlinks and refuses a second port for the same state directory', async () => {
    const root = await directory()
    const socket = socketPath(root)
    await writeFile(socket, 'do not delete')
    await expect(runtime(root)).rejects.toThrow('unsafe')
    expect(await readFile(socket, 'utf8')).toBe('do not delete')
    await rm(socket)
    const target = join(root, 'private')
    await writeFile(target, 'private')
    await symlink(target, socket)
    await expect(runtime(root)).rejects.toThrow('unsafe')
    expect(await readFile(target, 'utf8')).toBe('private')
    await rm(socket)
    const first = await runtime(root)
    await expect(runtime(root)).rejects.toThrow('already owns')
    expect((await daemonStatus(root))?.instanceId).toBe(first.control!.instanceId)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(socket)).mode & 0o777).toBe(0o600)
  })

  it('keeps connection secrets separate from status and authenticates existing HTTP APIs', async () => {
    const root = await directory()
    const owner = await runtime(root)
    const status = (await daemonStatus(root))!
    expect(JSON.stringify(status)).not.toContain(owner.access.bootstrapToken)
    expect(
      await controlRequest(socketPath(root), {
        protocol: 1,
        method: 'connect',
        instanceId: 'wrong',
      }),
    ).toMatchObject({ ok: false, code: 'instance_changed' })
    const token = await connectDaemon(root, status)
    expect(token).toBe(owner.access.bootstrapToken)
    const client = new DaemonClient(status.apiOrigin)
    await client.authenticate(token)
    expect(await client.request('/api/sessions')).toEqual([])
    expect(await readFile(join(root, 'repos.json'), 'utf8').catch(() => '')).not.toContain(token)
  })

  it('refuses stop during an agent turn, retains chat on idle stop, and rotates secrets on restart', async () => {
    const root = await directory()
    const turn = deferred()
    const close = vi.fn(async () => undefined)
    const owner = await startDaemon({
      version: 'test',
      port: 0,
      stateDirectory: root,
      runner: new ReadyCommandRunner(),
      diffSource: {
        async *read() {
          yield 'diff --git a/a.ts b/a.ts'
          yield '--- a/a.ts'
          yield '+++ b/a.ts'
          yield '@@ -1 +1 @@'
          yield '-before'
          yield '+after'
        },
      },
      codexBackend: {
        async start() {
          return {
            async *send() {
              yield { type: 'assistant_delta', text: 'Saved review' }
              await turn.promise
              yield { type: 'turn_completed' }
            },
            interrupt: async () => undefined,
            close,
          }
        },
      },
    })
    cleanups.push(() => owner.app.close())
    owner.services.sessions.add(
      reviewSession({
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        config: {
          main: {
            backend: AgentBackendKind.Codex,
            shell: 'none',
            network: 'off',
            onOutOfScope: 'deny',
          },
        },
      }),
    )
    owner.services.chats.startReview('session-1')
    const status = (await daemonStatus(root))!
    try {
      await expect(stopDaemon(root, status)).rejects.toThrow('active work')
      expect(close).not.toHaveBeenCalled()
      turn.resolve()
      await vi.waitFor(() => expect(owner.services.chats.isBusy('session-1')).toBe(false))
      await stopDaemon(root, status)
      expect(close).toHaveBeenCalledOnce()
      expect(await daemonStatus(root)).toBeUndefined()
      const next = await runtime(root)
      expect(next.access.bootstrapToken).not.toBe(owner.access.bootstrapToken)
      expect(next.services.chats.get('session-1').entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: 'Saved review' })]),
      )
    } finally {
      turn.resolve()
    }
  })

  it('holds the port through shutdown persistence and reports errors instead of successful stop', async () => {
    const root = await directory()
    const owner = await runtime(root)
    const status = (await daemonStatus(root))!
    const gate = deferred()
    const close = owner.services.persistence.close.bind(owner.services.persistence)
    vi.spyOn(owner.services.persistence, 'close').mockImplementation(async () => {
      await gate.promise
      await close()
    })
    const closing = owner.app.close()
    try {
      await vi.waitFor(() => expect(owner.lifecycle.phase).toBe('stopping'))
      await expect(
        startDaemon({
          version: 'test',
          port: Number(new URL(status.apiOrigin).port),
          stateDirectory: join(root, 'other'),
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally {
      gate.resolve()
      await closing
    }

    const failed = await runtime(root)
    vi.spyOn(failed.services.persistence, 'close').mockRejectedValue(new Error('disk full'))
    // Use app.close directly here so expected errors do not change the test process exit code.
    await expect(failed.app.close()).rejects.toThrow('disk full')
    cleanups.pop()
  })

  it('does not overwrite partially restored sessions when initialization fails', async () => {
    const root = await directory()
    await mkdir(join(root, 'sessions'))
    const invalid = join(root, 'sessions', 'broken.json')
    await writeFile(invalid, '{ invalid json')
    await expect(
      createDaemon({ version: 'test', stateDirectory: root, runner: new ReadyCommandRunner() }),
    ).rejects.toThrow()
    expect(await readFile(invalid, 'utf8')).toBe('{ invalid json')
  })

  it('keeps an aborted HTTP mutation busy until its underlying work finishes', async () => {
    const root = await directory()
    const owner = await runtime(root)
    const status = (await daemonStatus(root))!
    const auth = await fetch(`${status.apiOrigin}/api/auth`, {
      method: 'POST',
      headers: { Origin: status.apiOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: owner.access.bootstrapToken }),
    })
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!
    const gate = deferred()
    const register = vi.spyOn(owner.services.repos, 'register').mockImplementation(async () => {
      await gate.promise
      return {
        id: 'owner/repo',
        owner: 'owner',
        name: 'repo',
        checkouts: [root],
        primaryCheckout: root,
      }
    })
    const abort = new AbortController()
    const writing = fetch(`${status.apiOrigin}/api/repos`, {
      method: 'POST',
      signal: abort.signal,
      headers: { Origin: status.apiOrigin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: root }),
    }).catch(() => undefined)
    try {
      await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
      abort.abort()
      await writing
      await expect(stopDaemon(root, status)).rejects.toThrow('active work')
    } finally {
      gate.resolve()
      await owner.app.close()
    }
  })
})
