import type { PreflightReport } from '@legible/protocol'

import { EventBus } from './events/event-bus.js'
import { NodeCommandRunner, type CommandRunner } from './preflight/command-runner.js'
import { PreflightService } from './preflight/service.js'
import { SessionRegistry } from './sessions/session-registry.js'

export type DaemonServices = {
  repoPath: string
  eventBus: EventBus
  preflight: PreflightService
  sessions: SessionRegistry
}

export type CreateServicesOptions = {
  repoPath: string
  runner?: CommandRunner
  now?: () => Date
  onListenerError?: (error: unknown) => void
}

export function createDaemonServices(options: CreateServicesOptions): DaemonServices {
  const eventBus = new EventBus({
    ...(options.now ? { now: options.now } : {}),
    ...(options.onListenerError ? { onListenerError: options.onListenerError } : {}),
  })
  const sessions = new SessionRegistry(eventBus)
  const publishPreflight = (report: PreflightReport) => {
    eventBus.publish({ type: 'preflight.updated', payload: report })
  }
  const preflight = new PreflightService(options.runner ?? new NodeCommandRunner(), {
    ...(options.now ? { now: options.now } : {}),
    onUpdated: publishPreflight,
  })

  return {
    repoPath: options.repoPath,
    eventBus,
    preflight,
    sessions,
  }
}
