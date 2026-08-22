import { describe, expect, it } from 'vitest'

import { NodeCommandRunner } from './command-runner.js'

describe('NodeCommandRunner', () => {
  it('reports missing executables without throwing', async () => {
    const runner = new NodeCommandRunner()

    await expect(
      runner.run('legible-command-that-does-not-exist', [], { timeoutMs: 100 }),
    ).resolves.toEqual({ status: 'missing' })
  })

  it('preserves non-zero exit codes', async () => {
    const runner = new NodeCommandRunner()
    const result = await runner.run(process.execPath, ['-e', 'process.exit(7)'], {
      timeoutMs: 1_000,
    })

    expect(result).toMatchObject({ status: 'completed', exitCode: 7 })
  })

  it('reports commands that exceed their timeout', async () => {
    const runner = new NodeCommandRunner()
    const result = await runner.run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      timeoutMs: 10,
    })

    expect(result).toEqual({ status: 'timed_out' })
  })
})
