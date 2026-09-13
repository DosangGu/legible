import { AgentBackendKind } from '@legible/protocol'
import type { AgentSpec, ChatSnapshot } from '@legible/protocol'
import { describe, expect, it, vi } from 'vitest'

import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  AgentStartOptions,
  McpServerProvider,
} from '../agents/types.js'
import { SessionDiffService } from '../diffs/service.js'
import type { DiffSource } from '../diffs/source.js'
import { EventBus } from '../events/event-bus.js'
import { SessionRegistry } from '../sessions/session-registry.js'
import { reviewSession } from '../testing/fixtures.js'
import {
  ChatBusyError,
  ChatItemNotFoundError,
  ChatService,
  ChatUnavailableError,
  InvalidChatMessageError,
  type ChatServiceOptions,
} from './service.js'

const codexSpec: AgentSpec = {
  backend: AgentBackendKind.Codex,
  shell: 'git',
  network: 'fetch',
  onOutOfScope: 'deny',
}

describe('ChatService', () => {
  it('starts explicitly, streams normalized entries, and retains a reconnect snapshot', async () => {
    const events: AgentEvent[] = [
      { type: 'session_started', id: 'codex-1', model: 'test-model' },
      { type: 'assistant_delta', text: 'Found ' },
      { type: 'tool_call', callId: 'tool-1', name: 'shell', input: { command: 'git show' } },
      {
        type: 'tool_result',
        callId: 'tool-1',
        name: 'shell',
        status: 'completed',
        output: 'x'.repeat(33 * 1024),
      },
      { type: 'assistant_delta', text: 'one issue.' },
      {
        type: 'turn_completed',
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          totalTokens: 15,
        },
      },
    ]
    const backend = scriptedBackend(() => events)
    const { chats, eventBus } = setup(backend)
    const published: string[] = []
    eventBus.subscribe((event) => published.push(event.type))

    expect(chats.get('session-1')).toMatchObject({ status: 'idle', entries: [] })
    expect(backend.start).not.toHaveBeenCalled()

    chats.startReview('session-1')
    const snapshot = await waitForSnapshot(chats, (value) => value.status === 'idle')

    expect(backend.start).toHaveBeenCalledOnce()
    const options = backend.start.mock.calls[0]?.[0]
    expect(options?.cwd).toBe('/state/worktrees/owner/repo/pr-42')
    expect(options?.systemPrompt).toContain('owner/repo pull request #42')
    expect(backend.inputs[0]).toContain('BEGIN UNTRUSTED DIFF')
    expect(backend.inputs[0]).toContain('+after')
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'message',
          role: 'user',
          text: 'Review this pull request.',
        }),
        expect.objectContaining({ kind: 'message', role: 'assistant', text: 'Found one issue.' }),
        expect.objectContaining({
          kind: 'tool',
          name: 'shell',
          status: 'completed',
          output: expect.stringContaining('output truncated by Legible'),
        }),
      ]),
    )
    expect(snapshot.lastUsage?.totalTokens).toBe(15)
    expect(published).toContain('chat.event')
    await chats.close()
  })

  it('rejects concurrent turns and interrupts the active turn', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const backend = scriptedBackend(async function* () {
      await blocked
      yield { type: 'error', retryable: true, category: 'interrupted' }
    })
    const { chats } = setup(backend)

    chats.send('session-1', 'Check this')
    await waitForSnapshot(chats, (value) => value.status === 'running')
    expect(() => chats.send('session-1', 'Again')).toThrow(ChatBusyError)
    chats.interrupt('session-1')
    expect(backend.interrupt).toHaveBeenCalledOnce()
    release()
    const snapshot = await waitForSnapshot(chats, (value) => value.status === 'idle')
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'notice', message: 'Review stopped.' }),
      ]),
    )
    await chats.close()
  })

  it('surfaces unsupported configuration and validates messages before spawning Codex', async () => {
    const backend = scriptedBackend(() => [])
    const { chats, sessions } = setup(backend, false)
    sessions.add(reviewSession())

    expect(chats.get('session-1').status).toBe('unavailable')
    expect(() => chats.startReview('session-1')).toThrow(ChatUnavailableError)
    sessions.remove('session-1')
    sessions.add(reviewSession({ config: { main: codexSpec } }))
    expect(() => chats.send('session-1', '   ')).toThrow(InvalidChatMessageError)
    expect(backend.start).not.toHaveBeenCalled()
    await chats.close()
  })

  it('retries a failed logical turn without duplicating its visible user message', async () => {
    let attempt = 0
    const close = vi.fn(async () => undefined)
    const backend: AgentBackend = {
      async start() {
        attempt += 1
        return {
          async *send() {
            if (attempt === 1) throw new Error('transport lost')
            yield { type: 'assistant_delta' as const, text: 'Recovered.' }
            yield { type: 'turn_completed' as const }
          },
          async interrupt() {},
          close,
        }
      },
    }
    const { chats } = setup(backend)

    chats.send('session-1', 'Explain this')
    await waitForSnapshot(chats, (value) => value.status === 'failed')
    chats.retry('session-1')
    const recovered = await waitForSnapshot(chats, (value) => value.status === 'idle')

    expect(
      recovered.entries.filter((entry) => entry.kind === 'message' && entry.role === 'user'),
    ).toHaveLength(1)
    expect(recovered.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', role: 'assistant', text: 'Recovered.' }),
      ]),
    )
    expect(close).toHaveBeenCalledOnce()
    await chats.close()
  })

  it('routes a turn to a draft comment and bootstraps it with the full diff', async () => {
    const backend = scriptedBackend(() => [
      { type: 'assistant_delta', text: 'The range is correct.' },
      { type: 'turn_completed' },
    ])
    const { chats, sessions } = setup(backend, false)
    sessions.add(
      reviewSession({
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        config: { main: codexSpec },
        comments: [
          {
            id: 'comment-1',
            path: 'a.ts',
            side: 'RIGHT',
            startLine: 1,
            line: 2,
            body: 'Could this be simpler?',
            origin: 'human',
            createdAt: '2026-08-22T00:00:00.000Z',
          },
        ],
      }),
    )

    const accepted = chats.send('session-1', 'Explain the tradeoff', 'comment-1')
    expect(accepted.itemId).toBe('comment-1')
    const snapshot = await waitForSnapshot(chats, (value) => value.status === 'idle')

    expect(backend.inputs[0]).toContain('BEGIN UNTRUSTED DIFF')
    expect(backend.inputs[0]).toContain('[comment #1: a.ts:1-2 RIGHT]')
    expect(backend.inputs[0]).toContain('Could this be simpler?')
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', role: 'user', itemId: 'comment-1' }),
        expect.objectContaining({
          kind: 'message',
          role: 'assistant',
          itemId: 'comment-1',
        }),
      ]),
    )
    await chats.close()
  })

  it('rejects a turn for a missing draft comment before spawning Codex', async () => {
    const backend = scriptedBackend(() => [])
    const { chats } = setup(backend)

    expect(() => chats.send('session-1', 'Explain this', 'missing')).toThrow(ChatItemNotFoundError)
    expect(backend.start).not.toHaveBeenCalled()
    await chats.close()
  })

  it('restores an interrupted daemon turn as retryable transcript state', async () => {
    const backend = scriptedBackend(() => [
      { type: 'assistant_delta', text: 'Resumed.' },
      { type: 'turn_completed' },
    ])
    const { chats } = setup(backend)
    chats.restore('session-1', {
      snapshot: {
        sessionId: 'session-1',
        revision: 3,
        status: 'running',
        backend: AgentBackendKind.Codex,
        currentTurnId: 'old-turn',
        entries: [
          {
            id: 'old-user',
            turnId: 'old-turn',
            createdAt: '2026-08-21T00:00:00.000Z',
            kind: 'message',
            role: 'user',
            text: 'Continue review',
          },
        ],
      },
      active: { kind: 'message', message: 'Continue review' },
    })

    expect(chats.get('session-1')).toMatchObject({ status: 'failed', revision: 4 })
    chats.retry('session-1')
    const snapshot = await waitForSnapshot(chats, (value) => value.status === 'idle')
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', role: 'assistant', text: 'Resumed.' }),
      ]),
    )
    expect(backend.inputs[0]).toContain('A previous ephemeral review thread was lost')
    await chats.close()
  })

  it('rotates and closes the MCP lease with the Codex agent session', async () => {
    let attempt = 0
    const backend: AgentBackend = {
      async start(options) {
        expect(options.mcpServers).toHaveLength(1)
        attempt += 1
        return {
          async *send() {
            if (attempt === 1) throw new Error('transport lost')
            yield { type: 'turn_completed' as const }
          },
          async interrupt() {},
          async close() {},
        }
      },
    }
    const closed: Array<ReturnType<typeof vi.fn>> = []
    const mcp: McpServerProvider = {
      open() {
        const close = vi.fn(async () => undefined)
        closed.push(close)
        return {
          spec: {
            name: 'legible_review',
            transport: 'http',
            url: 'http://127.0.0.1:7777/mcp',
          },
          close,
        }
      },
    }
    const { chats } = setup(backend, true, mcp)

    chats.send('session-1', 'Review')
    await waitForSnapshot(chats, (value) => value.status === 'failed')
    expect(closed[0]).toHaveBeenCalledOnce()
    chats.retry('session-1')
    await waitForSnapshot(chats, (value) => value.status === 'idle')
    expect(closed).toHaveLength(2)
    expect(closed[1]).not.toHaveBeenCalled()
    await chats.close()
    expect(closed[1]).toHaveBeenCalledOnce()
  })
  it('uses Claude for main and per-item turns and retains projection until the agent exits', async () => {
    const order: string[] = []
    const backend = scriptedBackend(() => [
      { type: 'notice', message: 'Authentication method reported by CLI' },
      { type: 'turn_completed' },
    ])
    backend.close.mockImplementation(async () => {
      order.push('agent closed')
    })
    const release = vi.fn(async () => {
      order.push('projection released')
    })
    const acquire = vi.fn(async () => {
      order.push('projection acquired')
      return { changes: [{ path: '.mcp.json' as const, action: 'removed' as const }], release }
    })
    const mcp: McpServerProvider = {
      open: vi.fn(() => ({
        spec: { name: 'legible_review', transport: 'http' as const, url: 'http://localhost/mcp' },
        close: async () => {
          order.push('mcp closed')
        },
      })),
    }
    const { chats, sessions } = setup(backend, false, mcp, {
      backends: { [AgentBackendKind.Claude]: backend },
      configProjection: { acquire },
    })
    sessions.add(
      reviewSession({
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        config: { main: { ...codexSpec, backend: AgentBackendKind.Claude, shell: 'none' } },
        comments: [
          {
            id: 'comment-1',
            path: 'a.ts',
            line: 2,
            side: 'RIGHT',
            body: 'Explain this',
            origin: 'human',
            createdAt: '2026-09-13T00:00:00Z',
          },
        ],
      }),
    )
    chats.startReview('session-1')
    await waitForSnapshot(chats, (value) => value.status === 'idle')
    chats.send('session-1', 'Soften this', 'comment-1')
    const snapshot = await waitForSnapshot(chats, (value) => value.status === 'idle')
    expect(snapshot.backend).toBe(AgentBackendKind.Claude)
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'notice',
          message: expect.stringContaining('Base agent configuration'),
        }),
      ]),
    )
    expect(backend.inputs[1]).toContain('[comment #1: a.ts:2 RIGHT]')
    expect(mcp.open).toHaveBeenCalledWith('session-1', AgentBackendKind.Claude)
    expect(acquire).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    await chats.seal('session-1')
    expect(order).toEqual([
      'projection acquired',
      'agent closed',
      'projection released',
      'mcp closed',
    ])
    await chats.close()
  })

  it('releases a projection after startup failure and reacquires it on retry', async () => {
    const backend = scriptedBackend(() => [{ type: 'turn_completed' }])
    backend.start.mockRejectedValueOnce(new Error('Claude startup failed'))
    const release = vi.fn(async () => undefined)
    const acquire = vi.fn(async () => ({ changes: [], release }))
    const { chats, sessions } = setup(backend, false, undefined, {
      backends: { [AgentBackendKind.Claude]: backend },
      configProjection: { acquire },
    })
    sessions.add(
      reviewSession({
        config: { main: { ...codexSpec, backend: AgentBackendKind.Claude, shell: 'none' } },
      }),
    )
    chats.send('session-1', 'Review')
    await waitForSnapshot(chats, (value) => value.status === 'failed')
    expect(release).toHaveBeenCalledOnce()
    chats.retry('session-1')
    await waitForSnapshot(chats, (value) => value.status === 'idle')
    expect(acquire).toHaveBeenCalledTimes(2)
    await chats.close()
  })

  it('blocks reuse and sealing after restoration fails without discarding the error', async () => {
    const backend = scriptedBackend(() => {
      throw new Error('Lost transport')
    })
    const release = vi.fn(async () => {
      throw new Error('Protected config changed')
    })
    const { chats, sessions } = setup(backend, false, undefined, {
      backends: { [AgentBackendKind.Claude]: backend },
      configProjection: { acquire: async () => ({ changes: [], release }) },
    })
    sessions.add(
      reviewSession({
        config: { main: { ...codexSpec, backend: AgentBackendKind.Claude, shell: 'none' } },
      }),
    )
    chats.send('session-1', 'Review')
    const snapshot = await waitForSnapshot(chats, (value) => value.status === 'failed')
    expect(snapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('Protected config changed') }),
      ]),
    )
    expect(() => chats.retry('session-1')).toThrow('cleanup requires recovery')
    await expect(chats.seal('session-1')).rejects.toThrow('cleanup requires recovery')
    expect(backend.start).toHaveBeenCalledOnce()
    await chats.close()
  })

  it('waits for startup during shutdown before restoring the worktree', async () => {
    let started!: (session: AgentSession) => void
    const backend = scriptedBackend(() => [])
    backend.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          started = resolve
        }),
    )
    const release = vi.fn(async () => undefined)
    const { chats, sessions } = setup(backend, false, undefined, {
      backends: { [AgentBackendKind.Claude]: backend },
      configProjection: { acquire: async () => ({ changes: [], release }) },
    })
    sessions.add(
      reviewSession({
        config: { main: { ...codexSpec, backend: AgentBackendKind.Claude, shell: 'none' } },
      }),
    )
    chats.send('session-1', 'Review')
    await vi.waitFor(() => expect(backend.start).toHaveBeenCalledOnce())
    const closing = chats.close()
    expect(release).not.toHaveBeenCalled()
    const close = vi.fn(async () => undefined)
    started({
      send: () => {
        throw new Error('must not send after shutdown')
      },
      interrupt: async () => undefined,
      close,
    })
    await closing
    expect(close).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })
})

function setup(
  backend: AgentBackend,
  addSession = true,
  mcp?: McpServerProvider,
  overrides: Partial<ChatServiceOptions> = {},
) {
  const eventBus = new EventBus()
  const sessions = new SessionRegistry(eventBus)
  if (addSession) {
    sessions.add(
      reviewSession({
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        config: { main: codexSpec },
      }),
    )
  }
  const diffs = new SessionDiffService(diffSource())
  const chats = new ChatService({
    sessions,
    diffs,
    eventBus,
    backends: { codex: backend },
    ...(mcp ? { mcp } : {}),
    now: () => new Date('2026-08-22T00:00:00.000Z'),
    idFactory: (() => {
      let id = 0
      return () => `id-${String(++id)}`
    })(),
    ...overrides,
  })
  return { chats, sessions, eventBus }
}

function scriptedBackend(
  events:
    (() => Iterable<AgentEvent> | AsyncIterable<AgentEvent>) | (() => AsyncGenerator<AgentEvent>),
) {
  const inputs: string[] = []
  const interrupt = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  const session: AgentSession = {
    send(input) {
      inputs.push(input)
      const source = events()
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of source) yield event
        },
      }
    },
    interrupt,
    close,
  }
  const start = vi.fn(async (options: AgentStartOptions) => {
    void options
    return session
  })
  return { start, inputs, interrupt, close } satisfies AgentBackend & {
    start: typeof start
    inputs: string[]
    interrupt: typeof interrupt
    close: typeof close
  }
}

function diffSource(): DiffSource {
  return {
    async *read() {
      yield 'diff --git a/a.ts b/a.ts'
      yield '--- a/a.ts'
      yield '+++ b/a.ts'
      yield '@@ -1 +1 @@'
      yield '-before'
      yield '+after'
    },
  }
}

async function waitForSnapshot(
  chats: ChatService,
  predicate: (snapshot: ChatSnapshot) => boolean,
): Promise<ChatSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = chats.get('session-1')
    if (predicate(snapshot)) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for chat state: ${JSON.stringify(chats.get('session-1'))}`)
}
