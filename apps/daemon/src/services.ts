import type { PreflightReport } from '@legible/protocol'

import { CodexBackend } from './agents/codex/backend.js'
import type { AppServerProcessFactory } from './agents/codex/app-server-client.js'
import type { AgentBackend } from './agents/types.js'
import { ChatService } from './chats/service.js'
import { SessionFileService } from './diffs/file-service.js'
import { NodeGitFileSource, type FileSource } from './diffs/file-source.js'
import { SessionDiffService } from './diffs/service.js'
import { NodeGitDiffSource, type DiffSource } from './diffs/source.js'
import { EventBus } from './events/event-bus.js'
import { NodeCommandRunner, type CommandRunner } from './preflight/command-runner.js'
import { PreflightService } from './preflight/service.js'
import { SessionRegistry } from './sessions/session-registry.js'
import { WorktreeService } from './worktrees/service.js'

export type DaemonServices = {
  repoPath: string
  agents: {
    codex: AgentBackend
  }
  chats: ChatService
  eventBus: EventBus
  diffs: SessionDiffService
  files: SessionFileService
  preflight: PreflightService
  sessions: SessionRegistry
  worktrees: WorktreeService
}

export type CreateServicesOptions = {
  repoPath: string
  runner?: CommandRunner
  diffSource?: DiffSource
  fileSource?: FileSource
  stateDirectory?: string
  worktreeTtlMs?: number
  now?: () => Date
  onListenerError?: (error: unknown) => void
  codexProcessFactory?: AppServerProcessFactory
  codexBackend?: AgentBackend
}

export function createDaemonServices(options: CreateServicesOptions): DaemonServices {
  const runner = options.runner ?? new NodeCommandRunner()
  const eventBus = new EventBus({
    ...(options.now ? { now: options.now } : {}),
    ...(options.onListenerError ? { onListenerError: options.onListenerError } : {}),
  })
  const sessions = new SessionRegistry(eventBus)
  const diffs = new SessionDiffService(options.diffSource ?? new NodeGitDiffSource())
  const files = new SessionFileService(diffs, options.fileSource ?? new NodeGitFileSource())
  const publishPreflight = (report: PreflightReport) => {
    eventBus.publish({ type: 'preflight.updated', payload: report })
  }
  const preflight = new PreflightService(runner, {
    ...(options.now ? { now: options.now } : {}),
    onUpdated: publishPreflight,
  })
  const worktrees = new WorktreeService({
    repoPath: options.repoPath,
    runner,
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(options.worktreeTtlMs !== undefined ? { ttlMs: options.worktreeTtlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const codex =
    options.codexBackend ??
    new CodexBackend({
      ...(options.codexProcessFactory ? { processFactory: options.codexProcessFactory } : {}),
    })
  const chats = new ChatService({
    sessions,
    diffs,
    eventBus,
    codex,
    ...(options.now ? { now: options.now } : {}),
  })

  return {
    repoPath: options.repoPath,
    agents: { codex },
    chats,
    diffs,
    eventBus,
    files,
    preflight,
    sessions,
    worktrees,
  }
}
