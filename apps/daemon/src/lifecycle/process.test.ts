import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { daemonStatus, stopDaemon } from '../cli/connection.js'
import { socketPath } from './control.js'

const children: ChildProcess[] = []
const directories: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await exited
    }
    if (child.connected) child.disconnect()
  }
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp('/tmp/legible-process-')
  directories.push(directory)
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return { directory, port: address.port }
}

function spawn(directory: string, port: number) {
  const child = fork(
    fileURLToPath(new URL('../testing/daemon-process.ts', import.meta.url)),
    [directory, String(port)],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  )
  children.push(child)
  const ready = new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture startup timed out')), 10_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('message', (message) => {
      clearTimeout(timeout)
      resolve(message as { ok: boolean; code?: string })
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      reject(new Error('Fixture exited before ready'))
    })
  })
  return { child, ready }
}

describe('Daemon process ownership', () => {
  it('initializes exactly once across simultaneous processes and recovers a SIGKILL socket', async () => {
    const { directory, port } = await fixture()
    const contenders = Array.from({ length: 3 }, () => spawn(directory, port))
    const results = await Promise.all(contenders.map((item) => item.ready))
    expect(results.filter((item) => item.ok)).toHaveLength(1)
    expect(results.filter((item) => !item.ok).every((item) => item.code === 'EADDRINUSE')).toBe(
      true,
    )
    expect(await readFile(join(directory, 'initializations'), 'utf8')).toBe('preflight\n')
    const previous = (await daemonStatus(directory))!
    const owner = contenders[results.findIndex((item) => item.ok)]!.child
    const exited = new Promise<void>((resolve) => owner.once('exit', () => resolve()))
    owner.kill('SIGKILL')
    await exited
    expect((await stat(socketPath(directory))).isSocket()).toBe(true)
    expect(await daemonStatus(directory)).toBeUndefined()
    expect((await spawn(directory, port).ready).ok).toBe(true)
    const next = (await daemonStatus(directory))!
    expect(next.instanceId).not.toBe(previous.instanceId)
    expect(await readFile(join(directory, 'initializations'), 'utf8')).toBe(
      'preflight\npreflight\n',
    )
    await stopDaemon(directory, next)
    expect(await daemonStatus(directory)).toBeUndefined()
  }, 20_000)

  it('returns shutdown failure to the CLI after closing the daemon', async () => {
    const { directory, port } = await fixture()
    const { child, ready } = spawn(directory, port)
    expect((await ready).ok).toBe(true)
    await new Promise<void>((resolve, reject) =>
      child.send('fail-persistence', (error) => (error ? reject(error) : resolve())),
    )
    await expect(stopDaemon(directory, (await daemonStatus(directory))!)).rejects.toThrow(
      'cleanup or persistence errors',
    )
    expect(await daemonStatus(directory)).toBeUndefined()
  }, 15_000)
})
