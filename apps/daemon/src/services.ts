import type { PreflightReport } from '@legible/protocol'

import { EventBus } from './events/event-bus.js'
import { NodeCommandRunner, type CommandRunner } from './preflight/command-runner.js'
import { PreflightService } from './preflight/service.js'
import { SessionRegistry } from './sessions/session-registry.js'
import { WorktreeService } from './worktrees/service.js'

export type DaemonServices = {
  repoPath: string
  eventBus: EventBus
  preflight: PreflightService
  sessions: SessionRegistry
  worktrees: WorktreeService
}

export type CreateServicesOptions = {
  repoPath: string
  runner?: CommandRunner
  stateDirectory?: string
  worktreeTtlMs?: number
  now?: () => Date
  onListenerError?: (error: unknown) => void
}

export function createDaemonServices(options: CreateServicesOptions): DaemonServices {
  const runner = options.runner ?? new NodeCommandRunner()
  const eventBus = new EventBus({
    ...(options.now ? { now: options.now } : {}),
    ...(options.onListenerError ? { onListenerError: options.onListenerError } : {}),
  })
  const sessions = new SessionRegistry(eventBus)
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

  return {
    repoPath: options.repoPath,
    eventBus,
    preflight,
    sessions,
    worktrees,
  }
}
