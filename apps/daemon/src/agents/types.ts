import type { AgentSpec } from '@legible/protocol'

export type AgentUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type AgentEvent =
  | { type: 'session_started'; id: string; model: string }
  | { type: 'notice'; message: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      callId: string
      name: string
      status: 'completed' | 'failed'
      output: unknown
    }
  | { type: 'turn_completed'; usage?: AgentUsage; costUsd?: number }
  | { type: 'error'; retryable: boolean; category: string; message?: string }

export type McpServerSpec =
  | {
      name: string
      transport: 'stdio'
      command: string
      args?: readonly string[]
      env?: Readonly<Record<string, string>>
      enabledTools?: readonly string[]
      required?: boolean
    }
  | {
      name: string
      transport: 'http'
      url: string
      headers?: Readonly<Record<string, string>>
      enabledTools?: readonly string[]
      required?: boolean
    }

export type McpServerLease = {
  spec: McpServerSpec
  close(): Promise<void>
}

export interface McpServerProvider {
  open(sessionId: string, origin: AgentSpec['backend']): McpServerLease
}

export type AgentStartOptions = {
  cwd: string
  systemPrompt: string
  mcpServers: readonly McpServerSpec[]
  spec: AgentSpec
}

export interface AgentSession {
  send(message: string): AsyncIterable<AgentEvent>
  interrupt(): Promise<void>
  close(): Promise<void>
}

export interface AgentBackend {
  start(options: AgentStartOptions): Promise<AgentSession>
}
