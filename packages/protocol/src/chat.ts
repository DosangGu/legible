export type ChatStatus = 'unavailable' | 'idle' | 'starting' | 'running' | 'interrupting' | 'failed'

export type ChatUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

type ChatEntryBase = {
  id: string
  turnId: string
  createdAt: string
}

export type ChatMessageEntry = ChatEntryBase & {
  kind: 'message'
  role: 'user' | 'assistant'
  text: string
}

export type ChatToolEntry = ChatEntryBase & {
  kind: 'tool'
  name: string
  status: 'running' | 'completed'
  input: string
  output?: string
}

export type ChatNoticeEntry = ChatEntryBase & {
  kind: 'notice'
  level: 'info' | 'error'
  message: string
  retryable: boolean
}

export type ChatEntry = ChatMessageEntry | ChatToolEntry | ChatNoticeEntry

export type ChatSnapshot = {
  sessionId: string
  revision: number
  status: ChatStatus
  backend: 'codex'
  model?: string
  unavailableReason?: string
  currentTurnId?: string
  entries: ChatEntry[]
  lastUsage?: ChatUsage
}

export type ChatStreamEvent =
  | { type: 'status'; status: ChatStatus; currentTurnId?: string }
  | { type: 'entry.added'; entry: ChatEntry }
  | { type: 'assistant.delta'; entryId: string; text: string }
  | { type: 'tool.completed'; entryId: string; output: string }
  | { type: 'usage'; usage: ChatUsage }

export type ChatEventPayload = {
  sessionId: string
  revision: number
  event: ChatStreamEvent
}

export type ChatCommandAccepted = {
  sessionId: string
  turnId: string
  revision: number
}
