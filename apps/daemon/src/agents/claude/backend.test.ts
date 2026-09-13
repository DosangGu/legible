import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentBackendKind } from '@legible/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AsyncQueue } from '../async-queue.js'
import type { AgentEvent, AgentStartOptions } from '../types.js'
import { ClaudeBackend, type ClaudeQuery, type ClaudeQueryFactory } from './backend.js'
import {
  authenticationNotice,
  buildClaudeOptions,
  type ClaudeSettingsResolver,
} from './configuration.js'

const directories: string[] = []
const emptySettings: ClaudeSettingsResolver = async () => ({
  effective: {},
  sources: [],
  provenance: {},
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function options(): Promise<AgentStartOptions> {
  const cwd = await mkdtemp(join(tmpdir(), 'legible-claude-test-'))
  directories.push(cwd)
  return {
    cwd,
    systemPrompt: 'Review only.',
    mcpServers: [],
    spec: {
      backend: AgentBackendKind.Claude,
      shell: 'none',
      network: 'off',
      onOutOfScope: 'deny',
    },
  }
}

function fakeQuery(scripts: Record<string, unknown>[][] = []) {
  const output = new AsyncQueue<SDKMessage>()
  const inputs: SDKUserMessage[] = []
  let requestOptions: Options | undefined
  const emit = (frame: Record<string, unknown>) => output.push(frame as SDKMessage)
  const client: ClaudeQuery = {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    initializationResult: vi.fn(async () => ({
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: [],
      models: [],
      account: { subscriptionType: 'max', tokenSource: 'claude-cli' },
    })),
    mcpServerStatus: vi.fn(async () => []),
    interrupt: vi.fn(async () => {
      emit(result({ subtype: 'error_during_execution', errors: ['Interrupted'] }))
      return undefined
    }),
    close: vi.fn(() => output.end()),
  }
  const factory: ClaudeQueryFactory = vi.fn(({ prompt, options }) => {
    requestOptions = options
    void (async () => {
      for await (const input of prompt) {
        inputs.push(input)
        for (const frame of scripts[inputs.length - 1] ?? []) emit(frame)
      }
    })()
    return client
  })
  const backend = new ClaudeBackend({
    queryFactory: factory,
    readSettings: emptySettings,
    executablePath: '/local/claude',
    timeoutMs: 100,
  })
  return {
    backend,
    factory,
    client,
    inputs,
    emit,
    output,
    get requestOptions() {
      return requestOptions
    },
  }
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Final answer',
    total_cost_usd: 0.1,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens: 5,
    },
    ...overrides,
  }
}

function assistant(
  content: unknown[],
  uuid = 'frame-1',
  id = 'message-1',
): Record<string, unknown> {
  return { type: 'assistant', uuid, parent_tool_use_id: null, message: { id, content } }
}

function stream(event: unknown): Record<string, unknown> {
  return { type: 'stream_event', parent_tool_use_id: null, event }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe('ClaudeBackend', () => {
  it('retains one process for multiple turns and does not duplicate streamed text blocks', async () => {
    const full = assistant([{ type: 'text', text: 'Hello' }])
    const fake = fakeQuery([
      [
        stream({ type: 'message_start', message: { id: 'message-1' } }),
        stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }),
        full,
        full,
        assistant([{ type: 'text', text: ' again' }], 'frame-2'),
        result(),
      ],
      [result({ result: 'Next answer', total_cost_usd: 0.15 })],
    ])
    const session = await fake.backend.start(await options())
    expect(fake.inputs).toHaveLength(0)
    const first = await collect(session.send('First'))
    expect(first.filter((event) => event.type === 'assistant_delta')).toEqual([
      { type: 'assistant_delta', text: 'Hello' },
      { type: 'assistant_delta', text: ' again' },
    ])
    expect(first.at(-1)).toMatchObject({
      type: 'turn_completed',
      usage: {
        inputTokens: 15,
        cachedInputTokens: 3,
        outputTokens: 5,
        totalTokens: 20,
      },
    })
    const second = await collect(session.send('Second'))
    expect(second.filter((event) => event.type === 'notice')).toHaveLength(0)
    const completed = second.at(-1)
    expect(completed?.type).toBe('turn_completed')
    if (completed?.type === 'turn_completed') expect(completed.costUsd).toBeCloseTo(0.05)
    expect(fake.factory).toHaveBeenCalledOnce()
    expect(fake.inputs.map(({ message }) => message.content)).toEqual(['First', 'Second'])
    await session.close()
    await session.close()
    expect(fake.client.close).toHaveBeenCalledOnce()
  })

  it('pairs completed tool inputs with their outcomes and preserves CLI error text', async () => {
    const fake = fakeQuery([
      [
        assistant([{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.ts' } }]),
        {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'call-1', content: 'missing', is_error: true },
            ],
          },
        },
        result({ subtype: 'error_during_execution', errors: ['Model is unavailable'] }),
      ],
    ])
    const session = await fake.backend.start(await options())
    const events = await collect(session.send('Read'))
    expect(events).toContainEqual({
      type: 'tool_result',
      callId: 'call-1',
      name: 'Read',
      status: 'failed',
      output: 'missing',
    })
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Model is unavailable' })
    await session.close()
  })

  it('interrupts a running turn and accepts another turn on the same session', async () => {
    const fake = fakeQuery([[], [result()]])
    const session = await fake.backend.start(await options())
    const pending = collect(session.send('Wait'))
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1))
    await session.interrupt()
    expect((await pending).at(-1)).toMatchObject({ type: 'error', category: 'interrupted' })
    expect((await collect(session.send('Continue'))).at(-1)?.type).toBe('turn_completed')
    await session.close()
  })

  it('settles active readers when the transport ends unexpectedly', async () => {
    const fake = fakeQuery()
    const session = await fake.backend.start(await options())
    const pending = collect(session.send('Wait'))
    fake.output.end()
    expect((await pending).at(-1)).toMatchObject({ type: 'error', category: 'transport' })
    await session.close()
  })

  it.each(['git', 'broad'] as const)('rejects shell %s before spawning', async (shell) => {
    const fake = fakeQuery()
    const opts = await options()
    opts.spec.shell = shell
    await expect(fake.backend.start(opts)).rejects.toThrow('shell: none')
    expect(fake.factory).not.toHaveBeenCalled()
  })

  it('rejects free network and interactive approvals', async () => {
    const fake = fakeQuery()
    const opts = await options()
    opts.spec.network = 'free'
    await expect(fake.backend.start(opts)).rejects.toThrow('network: off or fetch')
    opts.spec.network = 'off'
    opts.spec.onOutOfScope = 'ask'
    await expect(fake.backend.start(opts)).rejects.toThrow('onOutOfScope: deny')
    expect(fake.factory).not.toHaveBeenCalled()
  })

  it('fails initialization and closes the CLI if an unexpected MCP server is connected', async () => {
    const fake = fakeQuery()
    vi.mocked(fake.client.mcpServerStatus).mockResolvedValue([
      { name: 'untrusted', status: 'connected' },
    ])
    await expect(fake.backend.start(await options())).rejects.toThrow('unexpected Claude MCP')
    expect(fake.client.close).toHaveBeenCalledOnce()
    expect(fake.inputs).toHaveLength(0)
  })

  it('requires exactly the injected MCP tool set', async () => {
    const fake = fakeQuery()
    const opts = await options()
    opts.mcpServers = [
      {
        name: 'legible_review',
        transport: 'http',
        url: 'http://localhost/mcp',
        enabledTools: ['focus'],
        required: true,
      },
    ]
    vi.mocked(fake.client.mcpServerStatus).mockResolvedValue([
      { name: 'legible_review', status: 'connected', tools: [{ name: 'write_file' }] },
    ])
    await expect(fake.backend.start(opts)).rejects.toThrow('tool set does not match')
    expect(fake.inputs).toHaveLength(0)
  })

  it('stops when the CLI advertises permissions that differ from the requested restrictions', async () => {
    const fake = fakeQuery([
      [
        {
          type: 'system',
          subtype: 'init',
          tools: ['Read', 'Bash'],
          permissionMode: 'dontAsk',
          plugins: [],
        },
      ],
    ])
    const session = await fake.backend.start(await options())
    const events = await collect(session.send('Review'))
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('restricted tool configuration'),
    })
    await session.close()
  })

  it('waits for the spawned process to exit before close resolves', async () => {
    const fake = fakeQuery()
    let processHandle: ReturnType<NonNullable<Options['spawnClaudeCodeProcess']>> | undefined
    const backend = new ClaudeBackend({
      executablePath: '/local/claude',
      readSettings: emptySettings,
      queryFactory: (request) => {
        processHandle = request.options.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          env: {},
          signal: new AbortController().signal,
        })
        return fake.factory(request)
      },
    })
    const session = await backend.start(await options())
    await session.close()
    expect(processHandle?.signalCode).not.toBeNull()
  })
})

describe('Claude configuration', () => {
  it('preserves CLI authentication while disabling executable customizations and importing AGENTS.md', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-api-key')
    vi.stubEnv('GH_TOKEN', 'test-github-token')
    const opts = await options()
    await writeFile(join(opts.cwd, 'AGENTS.md'), 'Prefer explicit types.')
    opts.spec.model = 'future-model'
    opts.spec.effort = 'future-effort'
    const configured = await buildClaudeOptions(opts, '/local/claude', async () => ({
      effective: {
        enabledPlugins: { 'unsafe@example': true },
        permissions: { allow: ['Bash', 'Edit'] },
      },
      sources: [],
      provenance: {},
    }))
    expect(configured).toMatchObject({
      pathToClaudeCodeExecutable: '/local/claude',
      persistSession: false,
      strictMcpConfig: true,
      tools: ['Read', 'Glob', 'Grep'],
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
      settings: {
        disableAllHooks: true,
        disableSkillShellExecution: true,
        enabledPlugins: { 'unsafe@example': false },
      },
      extraArgs: { effort: 'future-effort', 'disable-slash-commands': null },
      model: 'future-model',
    })
    expect(configured.env?.ANTHROPIC_API_KEY).toBe('test-api-key')
    expect(configured.env?.GH_TOKEN).toBeUndefined()
    expect(configured.disallowedTools).toEqual(
      expect.arrayContaining(['Write', 'Edit', 'Bash', 'Skill', 'Agent', 'WebFetch']),
    )
    expect(configured.systemPrompt).toMatchObject({
      append: expect.stringContaining('Prefer explicit types.'),
    })
    expect(configured.extraArgs).not.toHaveProperty('bare')
    expect(configured.env?.HOME).toBe(process.env.HOME)
  })

  it('only enables web tools when fetch is selected', async () => {
    const opts = await options()
    opts.spec.network = 'fetch'
    const configured = await buildClaudeOptions(opts, '/local/claude', emptySettings)
    expect(configured.tools).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
    expect(configured.disallowedTools).not.toContain('WebFetch')
  })

  it('refuses managed hooks before spawning instead of pretending flags override them', async () => {
    const opts = await options()
    await expect(
      buildClaudeOptions(opts, '/local/claude', async () => ({
        effective: {},
        provenance: {},
        sources: [{ source: 'managed', settings: { disableAllHooks: false } }],
      })),
    ).rejects.toThrow('Managed Claude')
  })

  it('does not expose account identity or promise free usage from subscription metadata', () => {
    const notice = authenticationNotice({
      email: 'private@example.com',
      organization: 'secret-org',
      subscriptionType: 'max',
      tokenSource: 'cli',
    })
    expect(notice).toContain('usage credits')
    expect(notice).not.toContain('private@example.com')
    expect(notice).not.toContain('secret-org')
    expect(
      authenticationNotice({ subscriptionType: 'max', apiKeySource: 'ANTHROPIC_API_KEY' }),
    ).toContain('API key authentication')
    expect(authenticationNotice({})).toContain('could not be determined')
  })
})
