import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import type { AgentSpec } from '@legible/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent } from '../types.js'
import type { AppServerProcess } from './app-server-client.js'
import { CodexBackend, CodexConfigurationError, UnsupportedCodexOptionError } from './backend.js'

const roots: string[] = []
const baseSpec: AgentSpec = {
  backend: 'codex',
  model: 'future-model',
  effort: 'future-effort',
  shell: 'git',
  network: 'fetch',
  onOutOfScope: 'deny',
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CodexBackend', () => {
  it('starts an isolated ephemeral read-only thread and preserves native model knobs', async () => {
    const cwd = await temporaryDirectory()
    const server = new FakeAppServer({
      mcp_servers: { user_server: { command: 'user-mcp' } },
      plugins: {
        plugin: { mcp_servers: { plugin_server: { command: 'plugin-mcp' } } },
      },
    })
    const backend = new CodexBackend({ processFactory: () => server })

    const session = await backend.start(startOptions(cwd))
    const threadStart = server.findRequest('thread/start')
    expect(threadStart?.params).toMatchObject({
      cwd,
      model: 'future-model',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      config: {
        projects: { [cwd]: { trust_level: 'untrusted' } },
        history: { persistence: 'none' },
        agents: { enabled: false },
        features: { apps: false, shell_tool: true },
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
        },
        web_search: 'live',
        tools: { web_search: true },
        mcp_servers: { user_server: { enabled: false } },
        plugins: { plugin: { mcp_servers: { plugin_server: { enabled: false } } } },
      },
    })

    const eventsPromise = collect(session.send('Review this change'))
    await server.waitForRequest('turn/start')
    expect(server.findRequest('turn/start')?.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Review this change' }],
      model: 'future-model',
      effort: 'future-effort',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })

    server.notify('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'message-1',
      delta: 'Looks good',
    })
    server.notify('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        last: {
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 5,
          reasoningOutputTokens: 2,
          totalTokens: 15,
        },
      },
    })
    server.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    })

    await expect(eventsPromise).resolves.toEqual([
      { type: 'session_started', id: 'thread-1', model: 'future-model' },
      { type: 'assistant_delta', text: 'Looks good' },
      {
        type: 'turn_completed',
        usage: {
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 5,
          reasoningOutputTokens: 2,
          totalTokens: 15,
        },
      },
    ])
    await session.close()
  })

  it.each([
    {
      name: 'none/off',
      shell: 'none' as const,
      network: 'off' as const,
      shellEnabled: false,
      webSearch: 'disabled',
      commandNetwork: false,
    },
    {
      name: 'git/fetch',
      shell: 'git' as const,
      network: 'fetch' as const,
      shellEnabled: true,
      webSearch: 'live',
      commandNetwork: false,
    },
    {
      name: 'broad/free',
      shell: 'broad' as const,
      network: 'free' as const,
      shellEnabled: true,
      webSearch: 'live',
      commandNetwork: true,
    },
  ])('maps $name permissions explicitly', async (mapping) => {
    const cwd = await temporaryDirectory()
    const server = new FakeAppServer()
    const session = await new CodexBackend({ processFactory: () => server }).start(
      startOptions(cwd, { ...baseSpec, shell: mapping.shell, network: mapping.network }),
    )
    expect(server.findRequest('thread/start')?.params).toMatchObject({
      config: {
        features: { shell_tool: mapping.shellEnabled },
        web_search: mapping.webSearch,
      },
    })

    const eventsPromise = collect(session.send('Review'))
    await server.waitForRequest('turn/start')
    expect(server.findRequest('turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: mapping.commandNetwork },
    })
    server.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    })
    await eventsPromise
    await session.close()
  })

  it('normalizes tool events, rejects approvals, and interrupts file changes', async () => {
    const cwd = await temporaryDirectory()
    const server = new FakeAppServer()
    const session = await new CodexBackend({ processFactory: () => server }).start(
      startOptions(cwd),
    )
    const eventsPromise = collect(session.send('Review'))
    await server.waitForRequest('turn/start')

    server.request(91, 'item/commandExecution/requestApproval', {})
    await vi.waitFor(() => {
      expect(server.messages).toContainEqual({ id: 91, result: { decision: 'decline' } })
    })
    server.notify('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', command: 'git diff' },
    })
    server.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'command-1',
        type: 'commandExecution',
        aggregatedOutput: 'diff output',
        exitCode: 0,
        status: 'completed',
      },
    })
    server.notify('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'change-1', type: 'fileChange' },
    })
    await server.waitForRequest('turn/interrupt')
    server.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'interrupted' },
    })

    await expect(eventsPromise).resolves.toEqual([
      { type: 'session_started', id: 'thread-1', model: 'future-model' },
      { type: 'tool_call', name: 'shell', input: { command: 'git diff' } },
      {
        type: 'tool_result',
        name: 'shell',
        output: { output: 'diff output', exitCode: 0, status: 'completed' },
      },
      {
        type: 'error',
        retryable: false,
        category: 'security',
        message: 'Codex attempted a file change in a read-only review session',
      },
      { type: 'error', retryable: true, category: 'interrupted' },
    ])
    await session.close()
  })

  it('imports CLAUDE.md only when AGENTS.md is absent', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, 'CLAUDE.md'), 'Claude-only guidance')
    const fallbackServer = new FakeAppServer()
    const fallback = await new CodexBackend({ processFactory: () => fallbackServer }).start(
      startOptions(cwd),
    )
    expect(fallbackServer.findRequest('thread/start')?.params).toMatchObject({
      developerInstructions: expect.stringContaining('Claude-only guidance'),
    })
    await fallback.close()

    await writeFile(join(cwd, 'AGENTS.md'), 'Codex guidance')
    const nativeServer = new FakeAppServer()
    const native = await new CodexBackend({ processFactory: () => nativeServer }).start(
      startOptions(cwd),
    )
    expect(nativeServer.findRequest('thread/start')?.params).toMatchObject({
      developerInstructions: expect.not.stringContaining('Claude-only guidance'),
    })
    await native.close()
  })

  it('fails closed for unsupported routing, MCP injection, and active user MCP servers', async () => {
    const cwd = await temporaryDirectory()
    const backend = new CodexBackend({
      processFactory: () => {
        throw new Error('must not spawn')
      },
    })
    await expect(
      backend.start(startOptions(cwd, { ...baseSpec, onOutOfScope: 'ask' })),
    ).rejects.toBeInstanceOf(UnsupportedCodexOptionError)
    await expect(
      backend.start({
        ...startOptions(cwd),
        mcpServers: [{ name: 'legible', transport: 'http', url: 'http://localhost' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedCodexOptionError)

    const activeMcp = new FakeAppServer({}, true)
    await expect(
      new CodexBackend({ processFactory: () => activeMcp }).start(startOptions(cwd)),
    ).rejects.toBeInstanceOf(CodexConfigurationError)
  })

  it('rejects concurrent turns and surfaces transport exits', async () => {
    const cwd = await temporaryDirectory()
    const server = new FakeAppServer()
    const session = await new CodexBackend({ processFactory: () => server }).start(
      startOptions(cwd),
    )
    const first = collect(session.send('First'))
    expect(() => session.send('Second')).toThrow('already active')
    await server.waitForRequest('turn/start')
    server.stderr.write('process failed')
    server.exit(9)

    await expect(first).resolves.toEqual([
      { type: 'session_started', id: 'thread-1', model: 'future-model' },
      {
        type: 'error',
        retryable: true,
        category: 'transport',
        message: 'Codex app-server exited with code 9: process failed',
      },
    ])
  })
})

function startOptions(cwd: string, spec: AgentSpec = baseSpec) {
  return {
    cwd,
    systemPrompt: 'Focus on correctness.',
    mcpServers: [],
    spec,
  }
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'legible-codex-'))
  roots.push(root)
  return root
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

class FakeAppServer extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: Array<Record<string, unknown>> = []
  readonly #effectiveConfig: Record<string, unknown>
  readonly #activeMcp: boolean
  #buffer = ''

  constructor(effectiveConfig: Record<string, unknown> = {}, activeMcp = false) {
    super()
    this.#effectiveConfig = effectiveConfig
    this.#activeMcp = activeMcp
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => this.#receive(chunk))
  }

  findRequest(method: string): Record<string, unknown> | undefined {
    return this.messages.find((message) => message.method === method)
  }

  async waitForRequest(method: string): Promise<Record<string, unknown>> {
    await vi.waitFor(() => expect(this.findRequest(method)).toBeDefined())
    return this.findRequest(method) as Record<string, unknown>
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  request(id: number, method: string, params: unknown): void {
    this.send({ id, method, params })
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.exit(null, signal)
    return true
  }

  #receive(chunk: string): void {
    this.#buffer += chunk
    const lines = this.#buffer.split('\n')
    this.#buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const message = JSON.parse(line) as Record<string, unknown>
      this.messages.push(message)
      this.#respond(message)
    }
  }

  #respond(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number' || typeof message.method !== 'string') return
    const id = message.id
    switch (message.method) {
      case 'initialize':
        this.send({ id, result: { userAgent: 'codex-test' } })
        break
      case 'config/read':
        this.send({ id, result: { config: this.#effectiveConfig } })
        break
      case 'thread/start':
        this.send({ id, result: { thread: { id: 'thread-1' } } })
        break
      case 'mcpServerStatus/list':
        this.send({
          id,
          result: {
            data: this.#activeMcp
              ? [{ name: 'active', serverInfo: { name: 'active' }, tools: {} }]
              : [],
            nextCursor: null,
          },
        })
        break
      case 'turn/start':
        this.send({ id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
        break
      case 'turn/interrupt':
        this.send({ id, result: {} })
        break
      default:
        this.send({ id, result: {} })
    }
  }

  #send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  private send(message: unknown): void {
    this.#send(message)
  }
}
