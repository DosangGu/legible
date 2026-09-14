import { fork, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  controlRequest,
  controlVersion,
  ControlError,
  privateDirectory,
  socketPath,
  type ControlStatus,
} from '../lifecycle/control.js'
import { validateWebOrigin } from '../server.js'

export async function daemonStatus(directory: string): Promise<ControlStatus | undefined> {
  const response = await controlRequest(socketPath(directory), {
    protocol: controlVersion,
    method: 'status',
  })
  if (!response) return undefined
  if (!response.ok) throw new ControlError(response.code, response.message)
  return response.status
}

export function assertCompatible(status: ControlStatus, version: string): void {
  if (status.version !== version)
    throw new Error(
      `Legible ${status.version} is running, but this CLI is ${version}. Stop it with its matching CLI before restarting.`,
    )
  const origin = new URL(validateWebOrigin(status.apiOrigin))
  if (origin.hostname !== '127.0.0.1' || origin.port !== '7777')
    throw new Error('Unexpected daemon API address; refusing to send credentials')
  validateWebOrigin(status.webOrigin)
}

async function launch(directory: string): Promise<ChildProcess> {
  const entry = fileURLToPath(new URL('../main.js', import.meta.url))
  await access(entry).catch(() => {
    throw new Error('Build Legible first with npm run build')
  })
  if (!process.env.LEGIBLE_WEB_ORIGIN)
    await access(fileURLToPath(new URL('../../../web/dist/index.html', import.meta.url))).catch(
      () => {
        throw new Error('Build the web app first with npm run build')
      },
    )
  await privateDirectory(directory)
  const log = await open(
    join(directory, 'daemon.log'),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const info = await log.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1)
      throw new Error('Unsafe daemon log file')
    await log.chmod(0o600)
    return fork(entry, ['--internal-background'], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
      execArgv: [],
      cwd: directory,
    })
  } finally {
    await log.close()
  }
}

export async function ensureDaemon(
  directory: string,
  version: string,
  options: {
    launch?: (directory: string) => Promise<ChildProcess>
    timeoutMs?: number
  } = {},
): Promise<ControlStatus> {
  let status = await daemonStatus(directory)
  if (status) assertCompatible(status, version)
  if (status?.phase === 'ready') return status
  if (status?.phase === 'stopping') throw new Error('Legible is stopping; retry after it exits')
  let child: ChildProcess | undefined
  let failure: string | undefined
  let collided = false
  if (!status) {
    child = await (options.launch ?? launch)(directory)
    child.on('error', () => {
      failure = 'Unable to spawn Legible; check daemon.log'
    })
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const data = message as { type?: string; code?: string; message?: string }
      if (data.type === 'failed') {
        if (data.code === 'EADDRINUSE') collided = true
        else failure = 'Legible startup failed; check daemon.log'
      }
    })
    child.on('exit', (code) => {
      if (code !== 0 && !collided) failure ??= 'Legible exited during startup; check daemon.log'
    })
  }
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    do {
      status = await daemonStatus(directory)
      if (status) {
        assertCompatible(status, version)
        if (status.phase === 'ready') return status
        if (status.phase === 'stopping')
          throw new Error('Legible is stopping; retry after it exits')
      }
      if (failure) throw new Error(failure)
      await delay(100)
    } while (Date.now() < deadline)
    throw new Error(
      collided
        ? 'Port 7777 is occupied but no matching Legible daemon is available; no process was stopped'
        : 'Legible is not ready after 30 seconds. Check legible status and daemon.log; no process was killed',
    )
  } finally {
    if (child?.connected) child.disconnect()
    child?.unref()
  }
}

export async function connectDaemon(directory: string, status: ControlStatus): Promise<string> {
  const response = await controlRequest(socketPath(directory), {
    protocol: controlVersion,
    method: 'connect',
    instanceId: status.instanceId,
  })
  if (!response) throw new Error('Legible stopped; retry the command')
  if (!response.ok) throw new ControlError(response.code, response.message)
  if (!response.token) throw new Error('Legible did not provide a connection token')
  return response.token
}

export async function stopDaemon(directory: string, status: ControlStatus): Promise<void> {
  const response = await controlRequest(socketPath(directory), {
    protocol: controlVersion,
    method: 'stop',
    instanceId: status.instanceId,
  })
  if (!response) return
  if (!response.ok) throw new ControlError(response.code, response.message)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const current = await daemonStatus(directory)
    if (!current || current.instanceId !== status.instanceId) return
    await delay(100)
  }
  throw new Error('Legible is still stopping. Check daemon.log; it was not force-killed')
}
