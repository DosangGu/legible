import { AgentBackendKind } from '@legible/protocol'
import type { ChatSnapshot } from '@legible/protocol'
import { describe, expect, it } from 'vitest'

import { applyChatEvent } from './use-chat.js'

describe('applyChatEvent', () => {
  it('applies revisioned deltas without mutating the previous snapshot', () => {
    const snapshot: ChatSnapshot = {
      sessionId: 'session-1',
      revision: 2,
      status: 'running',
      backend: AgentBackendKind.Codex,
      currentTurnId: 'turn-1',
      entries: [
        {
          id: 'assistant-1',
          turnId: 'turn-1',
          createdAt: '2026-08-22T00:00:00.000Z',
          kind: 'message',
          role: 'assistant',
          text: 'Part ',
        },
      ],
    }

    const next = applyChatEvent(snapshot, {
      sessionId: 'session-1',
      revision: 3,
      event: { type: 'assistant.delta', entryId: 'assistant-1', text: 'two' },
    })

    expect(snapshot.entries[0]).toMatchObject({ text: 'Part ' })
    expect(next).toMatchObject({ revision: 3, entries: [{ text: 'Part two' }] })
  })

  it('tracks the active and retry conversation from status events', () => {
    const snapshot: ChatSnapshot = {
      sessionId: 'session-1',
      revision: 2,
      status: 'idle',
      backend: AgentBackendKind.Codex,
      entries: [],
    }

    const running = applyChatEvent(snapshot, {
      sessionId: 'session-1',
      revision: 3,
      event: {
        type: 'status',
        status: 'running',
        currentTurnId: 'turn-1',
        currentItemId: 'comment-1',
      },
    })
    const failed = applyChatEvent(running, {
      sessionId: 'session-1',
      revision: 4,
      event: { type: 'status', status: 'failed', retryItemId: 'comment-1' },
    })

    expect(running).toMatchObject({
      status: 'running',
      currentTurnId: 'turn-1',
      currentItemId: 'comment-1',
    })
    expect(failed).toMatchObject({ status: 'failed', retryItemId: 'comment-1' })
    expect(failed.currentTurnId).toBeUndefined()
    expect(failed.currentItemId).toBeUndefined()
  })
})
