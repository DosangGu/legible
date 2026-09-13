import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentBackendKind } from '@legible/protocol'
import { describe, it, expect } from 'vitest'

import { ClaudeBackend } from './backend.js'

describe.runIf(process.env.LEGIBLE_CLAUDE_INTEGRATION === '1')(
  'local Claude CLI integration',
  () => {
    it('initializes and closes without sending a model prompt', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'legible-claude-integration-'))
      try {
        const session = await new ClaudeBackend().start({
          cwd,
          systemPrompt: 'Review only.',
          mcpServers: [],
          spec: {
            backend: AgentBackendKind.Claude,
            shell: 'none',
            network: 'off',
            onOutOfScope: 'deny',
          },
        })
        await expect(session.close()).resolves.toBeUndefined()
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    }, 15_000)
  },
)
