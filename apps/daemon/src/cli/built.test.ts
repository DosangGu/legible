import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { repositoryFixture } from '../testing/repository.js'
import { daemonStatus, stopDaemon } from './connection.js'
import type { ControlStatus } from '../lifecycle/control.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

describe.runIf(process.env.LEGIBLE_BUILT_CLI_TEST === '1')(
  'built CLI with isolated local fixtures',
  () => {
    it('starts/attaches concurrently, prints safe status, routes PRs without creation, and stops/restarts cleanly', async (context) => {
      // The public CLI intentionally has one fixed port. Never stop an unrelated listener.
      const probe = createServer()
      try {
        await new Promise<void>((resolve, reject) => {
          probe.once('error', reject)
          probe.listen(7777, '127.0.0.1', resolve)
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          context.skip('Port 7777 is occupied; existing processes were left untouched')
          return
        }
        throw error
      } finally {
        if (probe.listening) await new Promise<void>((resolve) => probe.close(() => resolve()))
      }
      const fixture = await repositoryFixture('demo/cli-fixture', '/tmp')
      const stateHome = join(fixture.root, 'xdg')
      const directory = join(stateHome, 'legible')
      const bin = join(fixture.root, 'bin')
      const checks = join(fixture.root, 'checks')
      try {
        await mkdir(bin)
        // Only auth/version probes are permitted. No contributor credentials or model traffic.
        const shim = `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(checks)}, args.join(' ') + '\\n');\nif (args.join(' ') !== '--version' && args.join(' ') !== 'auth status' && args.join(' ') !== 'login status') process.exit(99);\nsetTimeout(() => console.log('fixture ready'), Number(process.env.LEGIBLE_FIXTURE_DELAY ?? 0));\n`
        for (const tool of ['gh', 'claude', 'codex'])
          await writeFile(join(bin, tool), shim, { mode: 0o755 })
        const env = {
          ...process.env,
          XDG_STATE_HOME: stateHome,
          LEGIBLE_BROWSE_ROOT: fixture.root,
          LEGIBLE_WEB_ORIGIN: 'http://127.0.0.1:7777',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        }
        const run = (args: string[], cwd = fixture.checkout) =>
          exec(cli, args, { env, cwd, timeout: 40_000, maxBuffer: 256 * 1024 })
        expect((await stat(cli)).mode & 0o111).not.toBe(0)
        const absent = await run(['status'])
        expect(absent.stdout).toContain('not running')
        const outputs = await Promise.all(
          Array.from({ length: 3 }, () => run(['pr', '42', '--no-open'])),
        )
        const urls = outputs.map(
          (result) => new URL(result.stdout.trim().replace('Open Legible: ', '')),
        )
        expect(new Set(urls.map((url) => url.href)).size).toBe(1)
        expect(urls[0]!.pathname).toBe('/repos/demo/cli-fixture')
        expect(urls[0]!.search).toBe('?pr=42')
        const token = new URLSearchParams(urls[0]!.hash.slice(1)).get('token')!
        expect(token.length).toBeGreaterThan(30)
        const status = (await daemonStatus(directory))!
        expect(status.phase).toBe('ready')
        expect((await run(['status'])).stdout).not.toContain(token)
        expect((await readFile(checks, 'utf8')).trim().split('\n')).toHaveLength(6)
        expect(await readdir(join(directory, 'sessions'))).toEqual([])
        expect(await readFile(join(directory, 'daemon.log'), 'utf8')).not.toContain(token)
        expect(await readFile(join(directory, 'daemon.log'), 'utf8')).not.toContain('#token=')
        expect((await stat(join(directory, 'daemon.log'))).mode & 0o777).toBe(0o600)
        expect((await run(['add', 'checkout'], fixture.root)).stdout).toContain(
          'Registered demo/cli-fixture',
        )
        expect((await run(['stop'])).stdout).toContain('Legible stopped')
        expect(await daemonStatus(directory)).toBeUndefined()
        expect((await run(['stop'])).stdout).toContain('not running')
        const reopened = await run(['--no-open'])
        expect(reopened.stdout).not.toContain(token)
        const next = (await daemonStatus(directory))!
        expect(next.instanceId).not.toBe(status.instanceId)
        expect(
          JSON.parse(await readFile(join(directory, 'repos.json'), 'utf8')).repos,
        ).toHaveLength(1)
        // Production signal handling uses the same persistence/cleanup path as stop.
        process.kill(next.pid, 'SIGTERM')
        await expect.poll(() => daemonStatus(directory)).toBeUndefined()
        const finishing = exec(
          process.execPath,
          [join(cli, '..', 'main.js'), '--internal-background'],
          {
            cwd: fixture.root,
            env: { ...env, LEGIBLE_FIXTURE_DELAY: '1000' },
            timeout: 15_000,
          },
        ).then(
          () => true,
          () => false,
        )
        let initializing: ControlStatus | undefined
        await expect
          .poll(
            async () => {
              initializing = await daemonStatus(directory)
              return initializing?.phase
            },
            { timeout: 10_000 },
          )
          .toBe('starting')
        process.kill(initializing!.pid, 'SIGTERM')
        expect(await finishing).toBe(true)
        expect(await daemonStatus(directory)).toBeUndefined()
      } finally {
        const status = await daemonStatus(directory).catch(() => undefined)
        if (status) await stopDaemon(directory, status)
        await rm(fixture.root, { recursive: true, force: true })
      }
    }, 60_000)
  },
)
