import type { ChatSnapshot } from '@legible/protocol'
import { describe, expect, it } from 'vitest'

import { applyChatEvent } from './use-chat.js'

describe('applyChatEvent', () => {
  it('applies revisioned deltas without mutating the previous snapshot', () => {
    const snapshot: ChatSnapshot = {
      sessionId: 'session-1',
      revision: 2,
      status: 'running',
      backend: 'codex',
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
})
