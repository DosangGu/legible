import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CodexBackend } from './backend.js'

const integrationEnabled = process.env.LEGIBLE_CODEX_INTEGRATION === '1'

describe.runIf(integrationEnabled)('Codex app-server integration', () => {
  it('initializes and closes an ephemeral thread without starting a model turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'legible-codex-integration-'))
    try {
      const session = await new CodexBackend().start({
        cwd,
        systemPrompt: 'Review only.',
        mcpServers: [],
        spec: {
          backend: 'codex',
          shell: 'none',
          network: 'off',
          onOutOfScope: 'deny',
        },
      })

      await expect(session.close()).resolves.toBeUndefined()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
