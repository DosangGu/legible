import type { FastifyInstance } from 'fastify'

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
