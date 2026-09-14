import type { FastifyInstance } from 'fastify'
import { fileURLToPath } from 'node:url'
import { BrowserAccess, isLoopback } from './api/access.js'

import type { FileSource } from './diffs/file-source.js'
import type { DiffSource } from './diffs/source.js'
import type { CommandRunner } from './preflight/command-runner.js'
import type { AgentBackend } from './agents/types.js'
import type { GitHubClient, PullRequestReader } from './github/client.js'
import { buildApp } from './api/app.js'
import { createDaemonServices, type DaemonServices } from './services.js'
import { defaultStateDirectory } from './common/state.js'
import { DaemonLifecycle } from './lifecycle/state.js'
import { DaemonControl, socketPath } from './lifecycle/control.js'

export const daemonHost = '127.0.0.1'
export const daemonPort = 7777

export type StartDaemonOptions = {
  version: string
  repoPath?: string
  browseRoot?: string
  pullRequestReader?: PullRequestReader
  webDirectory?: string
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
  claudeBackend?: AgentBackend
  githubClient?: GitHubClient
  webOrigin?: string
}

export type DaemonRuntime = {
  app: FastifyInstance
  services: DaemonServices
  access: BrowserAccess
  lifecycle: DaemonLifecycle
  control?: DaemonControl
}

async function configureDaemon(options: StartDaemonOptions) {
  const requestedPort = options.port ?? daemonPort
  const services = createDaemonServices({
    ...(options.repoPath ? { repoPath: options.repoPath } : {}),
    ...(options.browseRoot ? { browseRoot: options.browseRoot } : {}),
    ...(options.pullRequestReader ? { pullRequestReader: options.pullRequestReader } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.diffSource ? { diffSource: options.diffSource } : {}),
    ...(options.fileSource ? { fileSource: options.fileSource } : {}),
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(options.worktreeTtlMs !== undefined ? { worktreeTtlMs: options.worktreeTtlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.codexBackend ? { codexBackend: options.codexBackend } : {}),
    ...(options.claudeBackend ? { claudeBackend: options.claudeBackend } : {}),
    ...(options.githubClient ? { githubClient: options.githubClient } : {}),
    mcpOrigin: `http://127.0.0.1:${String(requestedPort)}`,
  })
  let restored = false
  const lifecycle = new DaemonLifecycle(() =>
    services.sessions.list().some((session) => services.chats.isBusy(session.id)),
  )
  const access = new BrowserAccess()
  const app = await buildApp({
    services,
    version: options.version,
    access,
    lifecycle,
    shutdown: async () => {
      await lifecycle.drain()
      try {
        await services.chats.close()
      } finally {
        try {
          if (restored) await services.persistence.close()
          else services.persistence.discard()
        } finally {
          await services.mcp.close()
        }
      }
    },
    ...(options.webDirectory ? { webDirectory: options.webDirectory } : {}),
    logger: options.logger ?? false,
    ...(options.now ? { now: options.now } : {}),
  })
  const runtime: DaemonRuntime = { app, services, access, lifecycle }
  app.addHook('onClose', async () => runtime.control?.close())
  await app.ready()
  async function initialize() {
    await services.repos.restore()
    const configRecovery = await services.configProjection.recover()
    await services.persistence.restore()
    restored = true
    await services.preflight.refresh()
    if (options.repoPath) await services.repos.register(options.repoPath).catch(() => undefined)
    for (const session of services.sessions.list()) {
      if (
        session.submission?.status === 'submitting' ||
        session.submission?.status === 'uncertain'
      ) {
        await services.submissions.reconcile(session.id).catch(() => undefined)
      }
    }

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

    lifecycle.phase = 'ready'
  }
  return { runtime, initialize }
}

/** In-process fixture entry point. Production entry points always use startDaemon. */
export async function createDaemon(options: StartDaemonOptions): Promise<DaemonRuntime> {
  const { runtime, initialize } = await configureDaemon(options)
  try {
    await initialize()
    return runtime
  } catch (error) {
    await runtime.app.close().catch(() => undefined)
    throw error
  }
}

export async function startDaemon(options: StartDaemonOptions): Promise<DaemonRuntime> {
  if (!isLoopback(options.host ?? daemonHost))
    throw new Error('Only loopback binding is supported; use an SSH tunnel for remote access')
  const { runtime, initialize } = await configureDaemon({
    ...options,
    webDirectory:
      options.webDirectory ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)),
  })
  try {
    await runtime.app.listen({
      host: options.host ?? daemonHost,
      port: options.port ?? daemonPort,
    })
    const address = runtime.app.server.address()
    if (typeof address === 'object' && address) {
      const host = options.host ?? daemonHost
      const apiOrigin = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${String(address.port)}`
      runtime.services.mcp.setOrigin(apiOrigin)
      const control = new DaemonControl({
        path: socketPath(options.stateDirectory ?? defaultStateDirectory()),
        version: options.version,
        apiOrigin,
        webOrigin: validateWebOrigin(options.webOrigin ?? apiOrigin),
        phase: () => runtime.lifecycle.phase,
        token: () => runtime.access.bootstrapToken,
        stop: () => runtime.lifecycle.requestStop(),
        close: () => runtime.app.close(),
        onError: (error) => {
          runtime.app.log.error({ err: error }, 'Daemon control or shutdown failed')
          process.exitCode = 1
        },
      })
      runtime.control = control
      // preClose finishes state writes while the TCP listener is still owned.
      await control.listen()
    }
    await initialize()
    return runtime
  } catch (error) {
    await runtime.app.close().catch(() => undefined)
    throw error
  }
}

export function validateWebOrigin(input: string): string {
  const url = new URL(input)
  if (
    url.protocol !== 'http:' ||
    !isLoopback(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('LEGIBLE_WEB_ORIGIN must be a local HTTP origin')
  return url.origin
}
