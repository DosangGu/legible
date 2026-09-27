import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { daemonStatus, stopDaemon } from './connection.js'

const exec = promisify(execFile)
const packageDirectory = fileURLToPath(new URL('../../../../dist/package/', import.meta.url))

describe.runIf(process.env.LEGIBLE_PACKAGE_TEST === '1')('installed local package', () => {
  it('installs one tarball, starts the daemon, serves its web assets, and stops cleanly', async (context) => {
    const probe = createServer()
    try {
      await new Promise<void>((ready, reject) => {
        probe.once('error', reject)
        probe.listen(7777, '127.0.0.1', ready)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        context.skip('Port 7777 is occupied; the existing process was left untouched')
        return
      }
      throw error
    } finally {
      if (probe.listening) await new Promise<void>((done) => probe.close(() => done()))
    }

    const root = await mkdtemp(join(tmpdir(), 'legible-package-'))
    const stateDirectory = join(root, 'state', 'legible')
    try {
      const pack = await exec(
        'npm',
        ['pack', packageDirectory, '--pack-destination', root, '--json'],
        {
          cwd: root,
          timeout: 30_000,
        },
      )
      const metadata = JSON.parse(pack.stdout) as Record<
        string,
        { filename: string; bundled: string[]; files: Array<{ path: string }> }
      >
      const artifact = metadata['@legible/legible']
      expect(artifact?.bundled).toContain('@legible/protocol')
      expect(artifact?.files.map((file) => file.path)).toContain('dist/web/index.html')
      const tarball = join(root, artifact!.filename)
      const install = join(root, 'install')
      // No package scripts execute; avoid inheriting project-scoped script allowlists.
      await exec(
        'npm',
        [
          'install',
          '--prefix',
          install,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--no-package-lock',
          tarball,
        ],
        {
          cwd: root,
          timeout: 120_000,
          env: { ...process.env, npm_config_allow_scripts: '' },
        },
      )
      const cli = join(install, 'node_modules', '.bin', 'legible')
      const installedPackage = join(install, 'node_modules', '@legible', 'legible')
      expect((await stat(cli)).isFile()).toBe(true)
      expect(
        (
          await stat(
            join(installedPackage, 'node_modules', '@legible', 'protocol', 'dist', 'index.js'),
          )
        ).isFile(),
      ).toBe(true)
      expect(await readFile(join(installedPackage, 'dist', 'web', 'index.html'), 'utf8')).toContain(
        'assets/',
      )
      expect((await exec(cli, ['--version'], { cwd: root })).stdout.trim()).toBe('0.0.0')
      expect((await exec(cli, ['--help'], { cwd: root })).stdout).toContain('legible status')

      const bin = join(root, 'bin')
      await mkdir(bin)
      const shim = `#!${process.execPath}\nconst args = process.argv.slice(2).join(' ');\nif (!['--version', 'auth status', 'login status'].includes(args)) process.exit(99);\nconsole.log('fixture ready');\n`
      for (const tool of ['gh', 'claude', 'codex'])
        await writeFile(join(bin, tool), shim, { mode: 0o755 })
      const env = {
        ...process.env,
        XDG_STATE_HOME: join(root, 'state'),
        LEGIBLE_BROWSE_ROOT: root,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      }
      delete env.LEGIBLE_WEB_ORIGIN
      const opened = await exec(cli, ['--no-open'], {
        cwd: resolve(root),
        env,
        timeout: 40_000,
      })
      expect(opened.stdout).toContain('Open Legible: http://127.0.0.1:7777/')
      expect((await daemonStatus(stateDirectory))?.phase).toBe('ready')
      const page = await fetch('http://127.0.0.1:7777/')
      expect(page.status).toBe(200)
      const html = await page.text()
      const asset = html.match(/\/assets\/[^"']+\.js/u)?.[0]
      expect(asset).toBeTruthy()
      const script = await fetch(`http://127.0.0.1:7777${asset}`)
      expect(script.status).toBe(200)
      await script.arrayBuffer()
      expect((await exec(cli, ['stop'], { cwd: root, env, timeout: 40_000 })).stdout).toContain(
        'Legible stopped',
      )
      expect(await daemonStatus(stateDirectory)).toBeUndefined()
    } finally {
      const status = await daemonStatus(stateDirectory).catch(() => undefined)
      if (status?.phase === 'ready') await stopDaemon(stateDirectory, status)
      await expect.poll(() => daemonStatus(stateDirectory), { timeout: 10_000 }).toBeUndefined()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
