import type { FastifyInstance } from 'fastify'

import type { FileSource } from './diffs/file-source.js'
import type { DiffSource } from './diffs/source.js'
import type { CommandRunner } from './preflight/command-runner.js'
import type { AgentBackend } from './agents/types.js'
import type { GitHubClient } from './github/client.js'
import { buildApp } from './api/app.js'
import { createDaemonServices, type DaemonServices } from './services.js'

export const daemonHost = '127.0.0.1'
export const daemonPort = 7777

export type StartDaemonOptions = {
  version: string
  repoPath: string
  host?: string
  port?: number
  logger?: boolean
  runner?: CommandRunner
  diffSource?: DiffSource
  fileSource?: FileSource
  stateDirectory?: string
  worktreeTtlMs?: number
  now?: () => Date
  codexBackend?: AgentBackend
  githubClient?: GitHubClient
}

export type DaemonRuntime = {
  app: FastifyInstance
  services: DaemonServices
}

export async function createDaemon(options: StartDaemonOptions): Promise<DaemonRuntime> {
  const requestedPort = options.port ?? daemonPort
  const services = createDaemonServices({
    repoPath: options.repoPath,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.diffSource ? { diffSource: options.diffSource } : {}),
    ...(options.fileSource ? { fileSource: options.fileSource } : {}),
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(options.worktreeTtlMs !== undefined ? { worktreeTtlMs: options.worktreeTtlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.codexBackend ? { codexBackend: options.codexBackend } : {}),
    ...(options.githubClient ? { githubClient: options.githubClient } : {}),
    mcpOrigin: `http://127.0.0.1:${String(requestedPort)}`,
  })
  const configRecovery = await services.configProjection.recover()
  await services.persistence.restore()
  await services.preflight.refresh()
  for (const session of services.sessions.list()) {
    if (session.submission?.status === 'submitting' || session.submission?.status === 'uncertain') {
      await services.submissions.reconcile(session.id).catch(() => undefined)
    }
  }

  const app = await buildApp({
    services,
    version: options.version,
    logger: options.logger ?? false,
    ...(options.now ? { now: options.now } : {}),
  })
  await app.ready()

  if (configRecovery.conflicts.length > 0 || configRecovery.failed.length > 0) {
    app.log.warn(
      {
        recovered: configRecovery.recovered.length,
        conflicts: configRecovery.conflicts,
        failed: configRecovery.failed,
      },
      'Some projected agent configuration could not be restored',
    )
  } else if (configRecovery.recovered.length > 0) {
    app.log.info(
      { recovered: configRecovery.recovered.length },
      'Restored projected agent configuration',
    )
  }

  try {
    const activePaths = services.sessions.list().map(({ worktreePath }) => worktreePath)
    const sweep = await services.worktrees.sweep(activePaths)
    if (sweep.removed.length > 0 || sweep.failed.length > 0) {
      app.log.info(
        { removed: sweep.removed.length, failed: sweep.failed.length },
        'Completed startup worktree sweep',
      )
    }
  } catch (error) {
    app.log.warn({ err: error }, 'Startup worktree sweep failed')
  }

  return { app, services }
}

export async function startDaemon(options: StartDaemonOptions): Promise<DaemonRuntime> {
  const runtime = await createDaemon(options)
  await runtime.app.listen({
    host: options.host ?? daemonHost,
    port: options.port ?? daemonPort,
  })
  const address = runtime.app.server.address()
  if (typeof address === 'object' && address) {
    runtime.services.mcp.setOrigin(`http://127.0.0.1:${String(address.port)}`)
  }
  return runtime
}
