import { AgentBackendKind } from '@legible/protocol'
import type { ReviewSession } from '@legible/protocol'

import type { CommandResult, CommandRunner } from '../preflight/command-runner.js'

export function reviewSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'session-1',
    repoId: 'owner/repo',
    prNumber: 42,
    headSha: 'head-sha',
    baseSha: 'base-sha',
    worktreePath: '/state/worktrees/owner/repo/pr-42',
    config: {
      main: {
        backend: AgentBackendKind.Claude,
        shell: 'git',
        network: 'fetch',
        onOutOfScope: 'deny',
      },
    },
    comments: [],
    createdAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  }
}

export class ReadyCommandRunner implements CommandRunner {
  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    const isAuth = args.includes('status')
    return {
      status: 'completed',
      exitCode: 0,
      stdout: isAuth ? 'authenticated@example.com' : `${command} version 1.0.0\nmore output`,
      stderr: '',
    }
  }
}
