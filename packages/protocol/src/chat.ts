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
  itemId?: string
}

export type ChatMessageEntry = ChatEntryBase & {
  kind: 'message'
  role: 'user' | 'assistant'
  text: string
}

export type ChatToolEntry = ChatEntryBase & {
  kind: 'tool'
  callId?: string
  name: string
  status: 'running' | 'completed' | 'failed'
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
  currentItemId?: string
  retryItemId?: string
  entries: ChatEntry[]
  lastUsage?: ChatUsage
}

export type ChatStreamEvent =
  | {
      type: 'status'
      status: ChatStatus
      currentTurnId?: string
      currentItemId?: string
      retryItemId?: string
    }
  | { type: 'entry.added'; entry: ChatEntry }
  | { type: 'assistant.delta'; entryId: string; text: string }
  | {
      type: 'tool.completed'
      entryId: string
      status: 'completed' | 'failed'
      output: string
    }
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
  itemId?: string
}
