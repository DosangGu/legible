import { AgentBackendKind } from '@legible/protocol'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AgentBackend } from '../agents/types.js'
import { createDaemonServices } from '../services.js'
import { reviewSession } from '../testing/fixtures.js'

const unusedBackend: AgentBackend = {
  async start() {
    throw new Error('Codex should not start during persistence restoration')
  },
}

describe('SessionPersistence', () => {
  it.each([AgentBackendKind.Codex, AgentBackendKind.Claude])(
    'restores %s sessions and bounded chat transcripts after restart',
    async (backend) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), 'legible-persistence-'))
      const session = reviewSession({
        config: {
          main: {
            backend,
            shell: 'none',
            network: 'fetch',
            onOutOfScope: 'deny',
          },
        },
      })
      const first = createDaemonServices({
        repoPath: '/repo',
        stateDirectory,
        codexBackend: unusedBackend,
      })
      await first.persistence.restore()
      first.sessions.add(session)
      first.chats.restore(session.id, {
        snapshot: {
          sessionId: session.id,
          revision: 7,
          status: 'idle',
          backend,
          entries: [
            {
              id: 'message-1',
              turnId: 'turn-1',
              createdAt: '2026-08-22T00:00:00.000Z',
              kind: 'message',
              role: 'assistant',
              text: 'Saved response',
            },
            {
              id: 'tool-1',
              turnId: 'turn-1',
              createdAt: '2026-08-22T00:00:00.000Z',
              kind: 'tool',
              name: 'shell',
              status: 'completed',
              input: 'git show',
              output: 'bounded output',
            },
          ],
        },
      })
      await first.persistence.save(session)
      await first.persistence.close()
      await first.chats.close()

      const second = createDaemonServices({
        repoPath: '/repo',
        stateDirectory,
        codexBackend: unusedBackend,
      })
      await second.persistence.restore()

      expect(second.sessions.get(session.id)).toEqual(session)
      expect(second.chats.get(session.id)).toMatchObject({
        revision: 7,
        entries: [
          { kind: 'message', text: 'Saved response' },
          { kind: 'tool', output: 'bounded output' },
        ],
      })
      await second.persistence.close()
      await second.chats.close()
    },
  )
})
