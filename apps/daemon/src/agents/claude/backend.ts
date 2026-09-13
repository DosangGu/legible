import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

import { AsyncQueue } from '../async-queue.js'
import type { AgentBackend, AgentEvent, AgentSession, AgentStartOptions } from '../types.js'
import {
  authenticationNotice,
  buildClaudeOptions,
  claudeTools,
  ClaudeConfigurationError,
  findClaudeExecutable,
  readClaudeSettings,
  validateClaudeSpec,
  type ClaudeSettingsResolver,
} from './configuration.js'

export type ClaudeQuery = AsyncIterable<SDKMessage> &
  Pick<Query, 'initializationResult' | 'mcpServerStatus' | 'interrupt' | 'close'>
export type ClaudeQueryFactory = (request: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => ClaudeQuery

export type ClaudeBackendOptions = {
  queryFactory?: ClaudeQueryFactory
  executablePath?: string
  readSettings?: ClaudeSettingsResolver
  timeoutMs?: number
}

export class ClaudeBackend implements AgentBackend {
  constructor(private readonly options: ClaudeBackendOptions = {}) {}

  async start(options: AgentStartOptions): Promise<AgentSession> {
    validateClaudeSpec(options)
    const executable = this.options.executablePath ?? (await findClaudeExecutable())
    const sdkOptions = await buildClaudeOptions(
      options,
      executable,
      this.options.readSettings ?? readClaudeSettings,
    )
    const session = new ClaudeSession(
      options,
      sdkOptions,
      this.options.queryFactory ?? query,
      this.options.timeoutMs ?? 10_000,
    )
    try {
      await session.initialize()
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }
}

type Turn = { queue: AsyncQueue<AgentEvent>; interrupted: boolean; text: boolean }

class ClaudeSession implements AgentSession {
  readonly #input = new AsyncQueue<SDKUserMessage>()
  readonly #query: ClaudeQuery
  readonly #tools: Set<string>
  readonly #toolNames = new Map<string, string>()
  readonly #streamedText = new Map<string, string>()
  readonly #seenFrames = new Set<string>()
  #streamMessageId = ''
  #active: Turn | undefined
  #process: ChildProcess | undefined
  #exit: Promise<void> = Promise.resolve()
  #closing: Promise<void> | undefined
  #closed = false
  #failure: Error | undefined
  #notice = ''
  #lastCost = 0

  constructor(
    private readonly startOptions: AgentStartOptions,
    sdkOptions: Options,
    factory: ClaudeQueryFactory,
    private readonly timeoutMs: number,
  ) {
    this.#tools = new Set(claudeTools(startOptions))
    this.#query = factory({
      prompt: this.#input,
      options: {
        ...sdkOptions,
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            env: options.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(options.signal ? { signal: options.signal } : {}),
          })
          // Discard diagnostic stderr: it can contain configuration/credential material.
          child.stderr.resume()
          this.#process = child
          this.#exit = new Promise<void>((resolve) => {
            child.once('exit', () => resolve())
            child.once('error', () => {
              if (!child.pid) resolve()
            })
          })
          return child
        },
      },
    })
    void this.#pump()
  }

  async initialize(): Promise<void> {
    const initialized = await withTimeout(
      this.#query.initializationResult(),
      this.timeoutMs,
      'Claude initialization timed out',
    )
    this.#notice = authenticationNotice(initialized.account)
    const deadline = Date.now() + this.timeoutMs
    while (true) {
      const statuses = await withTimeout(
        this.#query.mcpServerStatus(),
        this.timeoutMs,
        'Claude MCP initialization timed out',
      )
      const expected = new Map(this.startOptions.mcpServers.map((server) => [server.name, server]))
      if (statuses.some((server) => server.status !== 'disabled' && !expected.has(server.name))) {
        throw new ClaudeConfigurationError('An unexpected Claude MCP server remained active')
      }
      let pending = false
      for (const [name, spec] of expected) {
        const status = statuses.find((server) => server.name === name)
        if (!status || status.status === 'pending') {
          pending = true
          continue
        }
        if (status.status !== 'connected')
          throw new ClaudeConfigurationError(`Claude MCP server unavailable: ${name}`)
        const tools = status.tools?.map((tool) => tool.name) ?? []
        if (
          tools.length !== spec.enabledTools!.length ||
          spec.enabledTools!.some((tool) => !tools.includes(tool))
        ) {
          throw new ClaudeConfigurationError(`Claude MCP tool set does not match: ${name}`)
        }
      }
      if (this.#failure) throw this.#failure
      if (this.#closed) throw new Error('Claude session closed during initialization')
      if (!pending) return
      if (Date.now() >= deadline)
        throw new ClaudeConfigurationError('Claude MCP initialization timed out')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async *send(message: string): AsyncGenerator<AgentEvent> {
    if (this.#closed) throw new Error('Claude session is closed')
    if (this.#failure) throw this.#failure
    if (this.#active) throw new Error('A Claude turn is already active')
    const turn: Turn = { queue: new AsyncQueue(), interrupted: false, text: false }
    this.#active = turn
    this.#toolNames.clear()
    this.#streamedText.clear()
    this.#seenFrames.clear()
    if (this.#notice) {
      turn.queue.push({ type: 'notice', message: this.#notice })
      this.#notice = ''
    }
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: message },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    })
    try {
      yield* turn.queue
    } finally {
      // A consumer that abandons the stream must not leave a model turn running.
      if (this.#active === turn) await this.close()
    }
  }

  async interrupt(): Promise<void> {
    if (!this.#active) return
    this.#active.interrupted = true
    await withTimeout(this.#query.interrupt(), this.timeoutMs, 'Claude interruption timed out')
  }

  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    this.#closed = true
    this.#input.end()
    this.#finish({
      type: 'error',
      category: 'interrupted',
      retryable: true,
      message: 'Claude session closed',
    })
    try {
      this.#query.close()
    } finally {
      if (this.#process && this.#process.exitCode === null && this.#process.signalCode === null) {
        this.#process.kill('SIGTERM')
      }
      try {
        await withTimeout(this.#exit, 2_000, 'Claude did not exit')
      } catch {
        this.#process?.kill('SIGKILL')
        await withTimeout(this.#exit, 2_000, 'Claude process exit could not be confirmed')
      }
    }
  }

  async #pump(): Promise<void> {
    try {
      for await (const message of this.#query) {
        if (this.#closed) return
        this.#consume(message)
      }
      if (!this.#closed) throw new Error('Claude stream ended unexpectedly')
    } catch (error) {
      if (this.#closed) return
      this.#failure = error instanceof Error ? error : new Error('Claude transport failed')
      this.#finish({
        type: 'error',
        category: 'transport',
        retryable: true,
        message: this.#failure.message,
      })
      // Also stop an idle process whose transport has failed.
      void this.close().catch(() => undefined)
    }
  }

  #consume(message: SDKMessage): void {
    const turn = this.#active
    if (!turn) return
    if ('parent_tool_use_id' in message && message.parent_tool_use_id) {
      throw new ClaudeConfigurationError('Claude attempted to use a subordinate agent')
    }
    if (message.type === 'system' && message.subtype === 'init') {
      if (
        message.permissionMode !== 'dontAsk' ||
        message.tools.some((tool) => !this.#tools.has(tool)) ||
        message.plugins.length > 0
      ) {
        throw new ClaudeConfigurationError(
          'Claude runtime did not retain the restricted tool configuration',
        )
      }
      turn.queue.push({ type: 'session_started', id: message.session_id, model: message.model })
    } else if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'message_start') this.#streamMessageId = event.message.id
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const text = event.delta.text
        this.#streamedText.set(
          this.#streamMessageId,
          (this.#streamedText.get(this.#streamMessageId) ?? '') + text,
        )
        turn.text = true
        turn.queue.push({ type: 'assistant_delta', text })
      }
    } else if (message.type === 'assistant') {
      if (this.#seenFrames.has(message.uuid)) return
      this.#seenFrames.add(message.uuid)
      for (const block of message.message.content) {
        if (block.type === 'text') {
          const streamed = this.#streamedText.get(message.message.id) ?? ''
          if (streamed.startsWith(block.text)) {
            this.#streamedText.set(message.message.id, streamed.slice(block.text.length))
          } else if (block.text.startsWith(streamed)) {
            const text = block.text.slice(streamed.length)
            this.#streamedText.delete(message.message.id)
            if (text) {
              turn.text = true
              turn.queue.push({ type: 'assistant_delta', text })
            }
          } else throw new Error('Claude text stream did not match its completed block')
        } else if (block.type === 'tool_use') {
          if (!this.#tools.has(block.name))
            throw new ClaudeConfigurationError(
              `Claude attempted an unavailable tool: ${block.name}`,
            )
          if (this.#toolNames.has(block.id)) continue
          this.#toolNames.set(block.id, block.name)
          turn.queue.push({
            type: 'tool_call',
            callId: block.id,
            name: block.name,
            input: block.input,
          })
        }
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue
        const name = this.#toolNames.get(block.tool_use_id)
        if (name) {
          turn.queue.push({
            type: 'tool_result',
            callId: block.tool_use_id,
            name,
            status: block.is_error ? 'failed' : 'completed',
            output: block.content ?? '',
          })
        }
      }
    } else if (message.type === 'result') {
      if (turn.interrupted) {
        this.#finish({ type: 'error', category: 'interrupted', retryable: true })
      } else if (message.subtype !== 'success' || message.is_error) {
        this.#finish({
          type: 'error',
          category: 'claude',
          retryable: true,
          message: 'errors' in message ? message.errors.join('\n') : message.result,
        })
      } else {
        if (!turn.text && message.result)
          turn.queue.push({ type: 'assistant_delta', text: message.result })
        const cachedInputTokens = message.usage.cache_read_input_tokens ?? 0
        const inputTokens =
          message.usage.input_tokens +
          (message.usage.cache_creation_input_tokens ?? 0) +
          cachedInputTokens
        const outputTokens = message.usage.output_tokens
        const costUsd =
          message.total_cost_usd >= this.#lastCost
            ? message.total_cost_usd - this.#lastCost
            : message.total_cost_usd
        this.#lastCost = message.total_cost_usd
        this.#finish({
          type: 'turn_completed',
          costUsd,
          usage: {
            inputTokens,
            cachedInputTokens,
            outputTokens,
            reasoningOutputTokens: 0,
            totalTokens: inputTokens + outputTokens,
          },
        })
      }
    }
  }

  #finish(event: AgentEvent): void {
    const turn = this.#active
    this.#active = undefined
    turn?.queue.push(event)
    turn?.queue.end()
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
