import { describe, expect, it, vi } from 'vitest'

import type { CommandResult, CommandRunner } from './command-runner.js'
import { PreflightNotReadyError, PreflightService } from './service.js'
import { ReadyCommandRunner } from '../testing/fixtures.js'

describe('PreflightService', () => {
  it('returns a ready report without retaining authentication output', async () => {
    const service = new PreflightService(new ReadyCommandRunner(), {
      now: () => new Date('2026-08-21T02:00:00.000Z'),
    })

    const report = await service.refresh()

    expect(report.status).toBe('ready')
    expect(report.checkedAt).toBe('2026-08-21T02:00:00.000Z')
    expect(report.checks).toHaveLength(4)
    expect(report.checks[0]).toEqual({
      tool: 'git',
      status: 'ready',
      version: 'git version 1.0.0',
    })
    expect(report.checks.map(({ tool }) => tool)).toEqual(['git', 'gh', 'claude', 'codex'])
    expect(JSON.stringify(report)).not.toContain('authenticated@example.com')
  })

  it('maps tool and authentication failures to a degraded report', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (command, args): Promise<CommandResult> => {
        if (command === 'git') return { status: 'missing' }
        if (command === 'gh') {
          return args.includes('status')
            ? { status: 'completed', exitCode: 1, stdout: 'secret', stderr: 'secret' }
            : { status: 'completed', exitCode: 0, stdout: 'gh 1', stderr: '' }
        }
        if (command === 'claude') {
          return args.includes('status')
            ? { status: 'timed_out' }
            : { status: 'completed', exitCode: 0, stdout: 'claude 1', stderr: '' }
        }
        return { status: 'error' }
      }),
    }
    const service = new PreflightService(runner)

    const report = await service.refresh()

    expect(report.status).toBe('degraded')
    expect(report.checks.map(({ status }) => status)).toEqual([
      'missing',
      'unauthenticated',
      'error',
      'error',
    ])
    expect(report.checks[1]?.message).toBe('Authentication required')
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(() => service.assertReady()).toThrow(PreflightNotReadyError)
  })

  it('coalesces concurrent refreshes and publishes one update', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner: CommandRunner = {
      run: vi.fn(async (): Promise<CommandResult> => {
        await gate
        return { status: 'completed', exitCode: 0, stdout: 'version 1', stderr: '' }
      }),
    }
    const onUpdated = vi.fn()
    const service = new PreflightService(runner, { onUpdated })

    const first = service.refresh()
    const second = service.refresh()
    expect(first).toBe(second)
    release()
    await Promise.all([first, second])

    expect(runner.run).toHaveBeenCalledTimes(7)
    expect(onUpdated).toHaveBeenCalledOnce()
  })

  it('reports agent-specific local CLI login guidance', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (_command, args) =>
        args.includes('status')
          ? { status: 'completed', exitCode: 1, stdout: 'private account', stderr: '' }
          : { status: 'completed', exitCode: 0, stdout: 'version 1', stderr: '' },
      ),
    }
    const service = new PreflightService(runner)

    const report = await service.refresh()

    expect(report.checks[2]).toMatchObject({
      tool: 'claude',
      status: 'unauthenticated',
      message: 'Authentication required; run claude auth login',
    })
    expect(report.checks[3]).toMatchObject({
      tool: 'codex',
      status: 'unauthenticated',
      message: 'Authentication required; run codex login',
    })
    expect(JSON.stringify(report)).not.toContain('private account')
  })
})
