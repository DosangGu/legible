import type { AgentSpec, ChatSnapshot } from '@legible/protocol'
import { describe, expect, it, vi } from 'vitest'

import type { AgentBackend, AgentEvent, AgentSession, AgentStartOptions } from '../agents/types.js'
import { SessionDiffService } from '../diffs/service.js'
import type { DiffSource } from '../diffs/source.js'
import { EventBus } from '../events/event-bus.js'
import { SessionRegistry } from '../sessions/session-registry.js'
import { reviewSession } from '../testing/fixtures.js'
import {
  ChatBusyError,
  ChatService,
  ChatUnavailableError,
  InvalidChatMessageError,
} from './service.js'

const codexSpec: AgentSpec = {
  backend: 'codex',
  shell: 'git',
  network: 'fetch',
  onOutOfScope: 'deny',
}

describe('ChatService', () => {
  it('starts explicitly, streams normalized entries, and retains a reconnect snapshot', async () => {
    const events: AgentEvent[] = [
      { type: 'session_started', id: 'codex-1', model: 'test-model' },
      { type: 'assistant_delta', text: 'Found ' },
      { type: 'tool_call', name: 'shell', input: { command: 'git show' } },
      { type: 'tool_result', name: 'shell', output: 'x'.repeat(33 * 1024) },
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
        backend: 'codex',
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
})

function setup(backend: AgentBackend, addSession = true) {
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
    codex: backend,
    now: () => new Date('2026-08-22T00:00:00.000Z'),
    idFactory: (() => {
      let id = 0
      return () => `id-${String(++id)}`
    })(),
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
