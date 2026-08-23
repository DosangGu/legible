import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentSpec } from '@legible/protocol'

import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  AgentStartOptions,
  AgentUsage,
} from '../types.js'
import {
  AppServerClient,
  AppServerRpcError,
  AppServerTransportError,
  spawnCodexAppServer,
  type AppServerNotification,
  type AppServerProcessFactory,
  type AppServerRequest,
} from './app-server-client.js'

const reviewFraming =
  'You are reviewing this pull request. Repository guidance applies, but you must remain read-only and leave submission to the human reviewer.'

type ActiveTurn = {
  id?: string
  queue: AsyncQueue<AgentEvent>
  deltaItems: Set<string>
  usage?: AgentUsage
  startPromise: Promise<void>
  finished: boolean
}

export type CodexBackendOptions = {
  processFactory?: AppServerProcessFactory
  requestTimeoutMs?: number
}

export class UnsupportedCodexOptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedCodexOptionError'
  }
}

export class CodexConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexConfigurationError'
  }
}

export class CodexBackend implements AgentBackend {
  readonly #processFactory: AppServerProcessFactory
  readonly #requestTimeoutMs: number

  constructor(options: CodexBackendOptions = {}) {
    this.#processFactory = options.processFactory ?? spawnCodexAppServer
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  }

  async start(options: AgentStartOptions): Promise<AgentSession> {
    validateOptions(options)

    const client = new AppServerClient(this.#processFactory(), {
      requestTimeoutMs: this.#requestTimeoutMs,
    })
    client.handleRequests(handleServerRequest)

    try {
      await client.request('initialize', {
        clientInfo: {
          name: 'legible',
          title: 'Legible',
          version: '0.0.0',
        },
      })
      client.notify('initialized')

      const effectiveConfig = await readEffectiveConfig(client, options.cwd)
      const instructions = await buildDeveloperInstructions(options.cwd, options.systemPrompt)
      const response = await client.request('thread/start', {
        cwd: options.cwd,
        ...(options.spec.model ? { model: options.spec.model } : {}),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        serviceName: 'legible',
        developerInstructions: instructions,
        config: buildSessionConfig(options.cwd, options.spec, effectiveConfig, options.mcpServers),
      })
      const threadId = readNestedString(response, 'thread', 'id')
      if (!threadId) throw new CodexConfigurationError('Codex did not return a thread id')

      await assertMcpServersConfigured(client, threadId, options.mcpServers)
      return new CodexSession(client, threadId, options.spec)
    } catch (error) {
      client.close()
      client.kill('SIGTERM')
      throw error
    }
  }
}

class CodexSession implements AgentSession {
  readonly #unsubscribeNotification: () => void
  readonly #unsubscribeError: () => void
  #active: ActiveTurn | undefined
  #announced = false
  #closed = false

  constructor(
    private readonly client: AppServerClient,
    private readonly threadId: string,
    private readonly spec: AgentSpec,
  ) {
    this.#unsubscribeNotification = client.onNotification((notification) =>
      this.#handleNotification(notification),
    )
    this.#unsubscribeError = client.onError((error) => this.#handleTransportError(error))
  }

  send(message: string): AsyncIterable<AgentEvent> {
    if (this.#closed) throw new CodexConfigurationError('Codex session is closed')
    if (this.#active) throw new CodexConfigurationError('A Codex turn is already active')

    const queue = new AsyncQueue<AgentEvent>()
    const active: ActiveTurn = {
      queue,
      deltaItems: new Set(),
      startPromise: Promise.resolve(),
      finished: false,
    }
    this.#active = active

    if (!this.#announced) {
      this.#announced = true
      queue.push({
        type: 'session_started',
        id: this.threadId,
        model: this.spec.model ?? 'default',
      })
    }

    active.startPromise = this.#startTurn(active, message)
    return queue
  }

  async interrupt(): Promise<void> {
    const active = this.#active
    if (!active || active.finished) return

    try {
      await active.startPromise
    } catch {
      return
    }
    if (!active.id || active.finished) return

    await this.client.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: active.id,
    })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true

    try {
      await this.interrupt()
    } catch {
      // Closing must continue even when the active turn is already gone.
    }

    this.#unsubscribeNotification()
    this.#unsubscribeError()
    this.#finishActive()
    this.client.close()
    this.client.kill('SIGTERM')

    const exited = await Promise.race([
      this.client.waitForExit().then(() => true),
      delay(1_000).then(() => false),
    ])
    if (!exited) {
      this.client.kill('SIGKILL')
      await this.client.waitForExit()
    }
  }

  async #startTurn(active: ActiveTurn, message: string): Promise<void> {
    try {
      const response = await this.client.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: message }],
        ...(this.spec.model ? { model: this.spec.model } : {}),
        ...(this.spec.effort ? { effort: this.spec.effort } : {}),
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: this.spec.network === 'free',
        },
      })
      const turnId = readNestedString(response, 'turn', 'id')
      if (!turnId) throw new CodexConfigurationError('Codex did not return a turn id')
      active.id = turnId
    } catch (error) {
      if (!active.finished) {
        active.queue.push(errorEvent(error, 'turn_start'))
        this.#finish(active)
      }
    }
  }

  #handleNotification(notification: AppServerNotification): void {
    const active = this.#active
    if (!active || active.finished) return
    const params = asRecord(notification.params)
    if (!params || (typeof params.threadId === 'string' && params.threadId !== this.threadId))
      return

    if (notification.method === 'turn/started') {
      const id = readNestedString(params, 'turn', 'id')
      if (id) active.id = id
      return
    }

    if (typeof params.turnId === 'string' && active.id && params.turnId !== active.id) return

    switch (notification.method) {
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') {
          if (typeof params.itemId === 'string') active.deltaItems.add(params.itemId)
          active.queue.push({ type: 'assistant_delta', text: params.delta })
        }
        return
      case 'item/started':
        this.#handleItemStarted(active, params.item)
        return
      case 'item/completed':
        this.#handleItemCompleted(active, params.item)
        return
      case 'thread/tokenUsage/updated': {
        const usage = normalizeUsage(params.tokenUsage)
        if (usage) active.usage = usage
        return
      }
      case 'error': {
        const retryable = params.willRetry === true
        active.queue.push({
          type: 'error',
          retryable,
          category: 'codex',
          ...messageProperty(params.error),
        })
        return
      }
      case 'turn/completed':
        this.#handleTurnCompleted(active, params.turn)
        return
      default:
        return
    }
  }

  #handleItemStarted(active: ActiveTurn, value: unknown): void {
    const item = asRecord(value)
    if (!item || typeof item.type !== 'string') return
    const callId = typeof item.id === 'string' ? item.id : undefined

    if (item.type === 'commandExecution' && callId) {
      active.queue.push({
        type: 'tool_call',
        callId,
        name: 'shell',
        input: { command: typeof item.command === 'string' ? item.command : '' },
      })
    } else if (item.type === 'webSearch' && callId) {
      active.queue.push({
        type: 'tool_call',
        callId,
        name: 'web_search',
        input: { query: typeof item.query === 'string' ? item.query : '' },
      })
    } else if (item.type === 'mcpToolCall' && callId && typeof item.tool === 'string') {
      active.queue.push({
        type: 'tool_call',
        callId,
        name: item.tool,
        input: item.arguments,
      })
    } else if (item.type === 'fileChange') {
      active.queue.push({
        type: 'error',
        retryable: false,
        category: 'security',
        message: 'Codex attempted a file change in a read-only review session',
      })
      void this.interrupt()
    }
  }

  #handleItemCompleted(active: ActiveTurn, value: unknown): void {
    const item = asRecord(value)
    if (!item || typeof item.type !== 'string') return
    const callId = typeof item.id === 'string' ? item.id : undefined

    if (item.type === 'agentMessage') {
      const id = typeof item.id === 'string' ? item.id : undefined
      if ((!id || !active.deltaItems.has(id)) && typeof item.text === 'string' && item.text) {
        active.queue.push({ type: 'assistant_delta', text: item.text })
      }
    } else if (item.type === 'commandExecution' && callId) {
      active.queue.push({
        type: 'tool_result',
        callId,
        name: 'shell',
        status: item.status === 'failed' ? 'failed' : 'completed',
        output: {
          output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
          exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
          status: typeof item.status === 'string' ? item.status : 'unknown',
        },
      })
    } else if (item.type === 'webSearch' && callId) {
      active.queue.push({
        type: 'tool_result',
        callId,
        name: 'web_search',
        status: 'completed',
        output: { query: typeof item.query === 'string' ? item.query : '' },
      })
    } else if (item.type === 'mcpToolCall' && callId && typeof item.tool === 'string') {
      active.queue.push({
        type: 'tool_result',
        callId,
        name: item.tool,
        status: item.status === 'failed' ? 'failed' : 'completed',
        output:
          item.status === 'failed'
            ? { error: readString(asRecord(item.error)?.message) ?? 'MCP tool failed' }
            : (item.result ?? null),
      })
    }
  }

  #handleTurnCompleted(active: ActiveTurn, value: unknown): void {
    const turn = asRecord(value)
    const status = typeof turn?.status === 'string' ? turn.status : 'failed'

    if (status === 'completed') {
      active.queue.push({
        type: 'turn_completed',
        ...(active.usage ? { usage: active.usage } : {}),
      })
    } else {
      active.queue.push({
        type: 'error',
        retryable: status === 'interrupted',
        category: status === 'interrupted' ? 'interrupted' : 'turn_failed',
        ...messageProperty(turn?.error),
      })
    }
    this.#finish(active)
  }

  #handleTransportError(error: AppServerTransportError): void {
    const active = this.#active
    if (!active || active.finished) return
    active.queue.push(errorEvent(error, 'transport'))
    this.#finish(active)
  }

  #finish(active: ActiveTurn): void {
    if (active.finished) return
    active.finished = true
    active.queue.end()
    if (this.#active === active) this.#active = undefined
  }

  #finishActive(): void {
    const active = this.#active
    if (active) this.#finish(active)
  }
}

async function handleServerRequest(request: AppServerRequest): Promise<unknown> {
  if (
    request.method === 'item/commandExecution/requestApproval' ||
    request.method === 'item/fileChange/requestApproval'
  ) {
    return { decision: 'decline' }
  }

  throw new AppServerRpcError(`Legible rejected server request: ${request.method}`, -32_000)
}

function validateOptions(options: AgentStartOptions): void {
  if (options.spec.backend !== 'codex') {
    throw new UnsupportedCodexOptionError('CodexBackend requires backend: codex')
  }
  if (options.spec.onOutOfScope === 'ask') {
    throw new UnsupportedCodexOptionError('Codex approval routing is not implemented yet')
  }
  const names = new Set<string>()
  for (const server of options.mcpServers) {
    if (!server.name || names.has(server.name)) {
      throw new UnsupportedCodexOptionError('MCP server names must be non-empty and unique')
    }
    names.add(server.name)
  }
}

async function readEffectiveConfig(
  client: AppServerClient,
  cwd: string,
): Promise<Record<string, unknown>> {
  const response = await client.request('config/read', { cwd, includeLayers: false })
  return asRecord(asRecord(response)?.config) ?? {}
}

function buildSessionConfig(
  cwd: string,
  spec: AgentSpec,
  effectiveConfig: Record<string, unknown>,
  mcpServers: AgentStartOptions['mcpServers'],
): Record<string, unknown> {
  const webSearch = spec.network === 'off' ? 'disabled' : 'live'
  return {
    projects: { [cwd]: { trust_level: 'untrusted' } },
    history: { persistence: 'none' },
    agents: { enabled: false },
    features: {
      apps: false,
      shell_tool: spec.shell !== 'none',
    },
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
    web_search: webSearch,
    tools: { web_search: webSearch !== 'disabled' },
    mcp_servers: {
      ...disableNamedEntries(effectiveConfig.mcp_servers),
      ...Object.fromEntries(mcpServers.map((server) => [server.name, mcpServerConfig(server)])),
    },
    plugins: disablePluginMcpServers(effectiveConfig.plugins),
  }
}

function mcpServerConfig(server: AgentStartOptions['mcpServers'][number]): Record<string, unknown> {
  const common = {
    enabled: true,
    required: server.required ?? false,
    ...(server.enabledTools ? { enabled_tools: [...server.enabledTools] } : {}),
  }
  return server.transport === 'http'
    ? {
        ...common,
        url: server.url,
        ...(server.headers ? { http_headers: { ...server.headers } } : {}),
      }
    : {
        ...common,
        command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}),
      }
}

function disableNamedEntries(value: unknown): Record<string, { enabled: false }> {
  const entries = asRecord(value)
  if (!entries) return {}
  return Object.fromEntries(Object.keys(entries).map((name) => [name, { enabled: false }]))
}

function disablePluginMcpServers(value: unknown): Record<string, unknown> {
  const plugins = asRecord(value)
  if (!plugins) return {}

  return Object.fromEntries(
    Object.entries(plugins).flatMap(([pluginId, pluginValue]) => {
      const plugin = asRecord(pluginValue)
      const servers = disableNamedEntries(plugin?.mcp_servers)
      return Object.keys(servers).length > 0 ? [[pluginId, { mcp_servers: servers }] as const] : []
    }),
  )
}

async function assertMcpServersConfigured(
  client: AppServerClient,
  threadId: string,
  expectedServers: AgentStartOptions['mcpServers'],
): Promise<void> {
  const response = await client.request('mcpServerStatus/list', {
    threadId,
    detail: 'toolsAndAuthOnly',
    limit: 100,
  })
  const data = asRecord(response)?.data
  if (!Array.isArray(data)) {
    throw new CodexConfigurationError('Codex returned an invalid MCP server status')
  }

  const active = data.flatMap((value) => {
    const server = asRecord(value)
    const tools = asRecord(server?.tools)
    return server?.serverInfo !== null || (tools !== undefined && Object.keys(tools).length > 0)
      ? [{ name: readString(server?.name), tools: Object.keys(tools ?? {}) }]
      : []
  })
  const expected = new Map(expectedServers.map((server) => [server.name, server]))
  if (active.some(({ name }) => !name || !expected.has(name))) {
    throw new CodexConfigurationError('An unexpected MCP server remained active')
  }
  for (const [name, server] of expected) {
    const found = active.find((candidate) => candidate.name === name)
    if (!found) throw new CodexConfigurationError(`Required MCP server is unavailable: ${name}`)
    if (
      server.enabledTools &&
      (found.tools.length !== server.enabledTools.length ||
        server.enabledTools.some((tool) => !found.tools.includes(tool)))
    ) {
      throw new CodexConfigurationError(`MCP tool set does not match: ${name}`)
    }
  }
}

async function buildDeveloperInstructions(cwd: string, systemPrompt: string): Promise<string> {
  const parts = [reviewFraming, systemPrompt.trim()].filter(Boolean)
  const agents = await readOptional(join(cwd, 'AGENTS.md'))
  if (agents === undefined) {
    const claude = await readOptional(join(cwd, 'CLAUDE.md'))
    if (claude !== undefined) {
      parts.push('Repository guidance imported from CLAUDE.md:\n\n' + claude)
    }
  }
  return parts.join('\n\n')
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

function normalizeUsage(value: unknown): AgentUsage | undefined {
  const tokenUsage = asRecord(value)
  const usage = asRecord(tokenUsage?.last) ?? tokenUsage
  if (!usage) return undefined

  const inputTokens = numberValue(usage.inputTokens)
  const cachedInputTokens = numberValue(usage.cachedInputTokens)
  const outputTokens = numberValue(usage.outputTokens)
  const reasoningOutputTokens = numberValue(usage.reasoningOutputTokens)
  const totalTokens = numberValue(usage.totalTokens)
  if (
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined
  }

  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens }
}

function errorEvent(error: unknown, category: string): AgentEvent {
  return {
    type: 'error',
    retryable: error instanceof AppServerTransportError,
    category,
    ...(error instanceof Error ? { message: error.message } : {}),
  }
}

function messageProperty(value: unknown): { message?: string } {
  if (typeof value === 'string') return { message: value }
  const record = asRecord(value)
  return typeof record?.message === 'string' ? { message: record.message } : {}
}

function readNestedString(value: unknown, key: string, nestedKey: string): string | undefined {
  const nested = asRecord(asRecord(value)?.[key])
  const result = nested?.[nestedKey]
  return typeof result === 'string' ? result : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }

  readonly #values: T[] = []
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = []
  #ended = false

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  push(value: T): void {
    if (this.#ended) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.#values.push(value)
  }

  end(): void {
    if (this.#ended) return
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}
