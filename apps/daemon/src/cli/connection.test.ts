import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { controlRequest, type ControlStatus } from '../lifecycle/control.js'
import { connectDaemon, ensureDaemon, stopDaemon } from './connection.js'

vi.mock('../lifecycle/control.js', async (original) => ({
  ...(await original<typeof import('../lifecycle/control.js')>()),
  controlRequest: vi.fn(),
}))
afterEach(() => vi.resetAllMocks())
const status: ControlStatus = {
  protocol: 1,
  instanceId: '31a9b304-cbc5-44c8-8b73-138b97f17129',
  pid: 123,
  version: 'test',
  phase: 'ready',
  apiOrigin: 'http://127.0.0.1:7777',
  webOrigin: 'http://127.0.0.1:7777',
}
function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    disconnect: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
  })
  return { child, launch: vi.fn(async () => child as unknown as ChildProcess) }
}

describe('CLI daemon attachment', () => {
  it('reuses a ready instance without spawning or requesting a token', async () => {
    const { launch } = childProcess()
    vi.mocked(controlRequest).mockResolvedValue({ ok: true, status })
    expect(await ensureDaemon('/tmp/fixture', 'test', { launch })).toEqual(status)
    expect(launch).not.toHaveBeenCalled()
    expect(controlRequest).toHaveBeenCalledExactlyOnceWith('/tmp/fixture/daemon.sock', {
      protocol: 1,
      method: 'status',
    })
  })

  it('waits for an existing startup rather than spawning another daemon', async () => {
    const { launch } = childProcess()
    vi.mocked(controlRequest)
      .mockResolvedValueOnce({ ok: true, status: { ...status, phase: 'starting' } })
      .mockResolvedValue({ ok: true, status })
    expect(await ensureDaemon('/tmp/fixture', 'test', { launch })).toEqual(status)
    expect(launch).not.toHaveBeenCalled()
  })

  it('attaches to the winning instance after its own child loses the port race', async () => {
    const { child, launch } = childProcess()
    vi.mocked(controlRequest)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        child.emit('message', { type: 'failed', code: 'EADDRINUSE' })
        child.emit('exit', 1)
        return undefined
      })
      .mockResolvedValue({ ok: true, status })
    expect(await ensureDaemon('/tmp/fixture', 'test', { launch })).toEqual(status)
    expect(launch).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('reports startup failure without exposing a child-provided secret', async () => {
    const { child, launch } = childProcess()
    vi.mocked(controlRequest)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        child.emit('message', { type: 'failed', code: 'startup_failed', message: 'private-token' })
        return undefined
      })
    await expect(ensureDaemon('/tmp/fixture', 'test', { launch })).rejects.toThrow(
      'startup failed; check daemon.log',
    )
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('times out without killing a child, and refuses incompatible or stopping daemons', async () => {
    const { child, launch } = childProcess()
    vi.mocked(controlRequest).mockResolvedValue(undefined)
    await expect(ensureDaemon('/tmp/fixture', 'test', { launch, timeoutMs: 1 })).rejects.toThrow(
      'no process was killed',
    )
    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    vi.mocked(controlRequest).mockResolvedValue({
      ok: true,
      status: { ...status, version: 'other' },
    })
    await expect(ensureDaemon('/tmp/fixture', 'test', { launch })).rejects.toThrow('matching CLI')
    vi.mocked(controlRequest).mockResolvedValue({
      ok: true,
      status: { ...status, phase: 'stopping' },
    })
    await expect(ensureDaemon('/tmp/fixture', 'test', { launch })).rejects.toThrow('stopping')
    expect(launch).toHaveBeenCalledOnce()
  })

  it('uses instance-bound control requests and propagates busy/changed-instance responses', async () => {
    vi.mocked(controlRequest).mockResolvedValue({ ok: true, status, token: 'secret' })
    expect(await connectDaemon('/tmp/fixture', status)).toBe('secret')
    expect(controlRequest).toHaveBeenLastCalledWith('/tmp/fixture/daemon.sock', {
      protocol: 1,
      method: 'connect',
      instanceId: status.instanceId,
    })
    vi.mocked(controlRequest).mockResolvedValue({ ok: false, code: 'busy', message: 'Active work' })
    await expect(stopDaemon('/tmp/fixture', status)).rejects.toThrow('Active work')
    vi.mocked(controlRequest).mockResolvedValue({
      ok: false,
      code: 'instance_changed',
      message: 'Instance changed',
    })
    await expect(connectDaemon('/tmp/fixture', status)).rejects.toThrow('Instance changed')
  })
})
