import type { FastifyInstance } from 'fastify'

import type { FileSource } from './diffs/file-source.js'
import type { DiffSource } from './diffs/source.js'
import type { CommandRunner } from './preflight/command-runner.js'
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
}

export type DaemonRuntime = {
  app: FastifyInstance
  services: DaemonServices
}

export async function createDaemon(options: StartDaemonOptions): Promise<DaemonRuntime> {
  const services = createDaemonServices({
    repoPath: options.repoPath,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.diffSource ? { diffSource: options.diffSource } : {}),
    ...(options.fileSource ? { fileSource: options.fileSource } : {}),
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(options.worktreeTtlMs !== undefined ? { worktreeTtlMs: options.worktreeTtlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  await services.preflight.refresh()

  const app = await buildApp({
    services,
    version: options.version,
    logger: options.logger ?? false,
    ...(options.now ? { now: options.now } : {}),
  })
  await app.ready()

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
  return runtime
}
