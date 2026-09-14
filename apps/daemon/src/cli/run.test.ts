import { describe, expect, it, vi } from 'vitest'
import { parseArguments } from './arguments.js'
import { browserCommand, shouldOpenBrowser } from './browser.js'
import { DaemonClient, runCommand, type CliDependencies } from './run.js'
import { assertCompatible } from './connection.js'
import type { ControlStatus } from '../lifecycle/control.js'

const status: ControlStatus = {
  protocol: 1,
  instanceId: 'a1c3e447-6c2d-4c6c-b1b3-3c585ed97456',
  pid: 123,
  phase: 'ready',
  version: 'test',
  apiOrigin: 'http://127.0.0.1:7777',
  webOrigin: 'http://127.0.0.1:5173',
}
const repo = {
  id: 'owner/repo',
  owner: 'owner',
  name: 'repo',
  primaryCheckout: '/home/test/a repo',
}

function fixture(sessions: unknown[] = [], registrationFails = false) {
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (path === '/api/auth')
      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': 'legible_session=private-cookie; HttpOnly' },
      })
    if (path === '/api/repos' && registrationFails)
      return Response.json(
        { error: { code: 'invalid_repository', message: 'Not a supported checkout' } },
        { status: 409 },
      )
    return Response.json(path === '/api/repos' ? repo : options?.method === 'POST' ? {} : sessions)
  })
  const d: CliDependencies = {
    cwd: '/home/test',
    tty: true,
    env: {},
    ensure: vi.fn(async () => status),
    status: vi.fn(async () => status),
    connect: vi.fn(async () => 'private-token'),
    stop: vi.fn(async () => undefined),
    client: (origin) => new DaemonClient(origin, fetcher),
    open: vi.fn(async () => undefined),
    output: vi.fn(),
    warn: vi.fn(),
  }
  return { d, fetcher }
}

describe('CLI commands', () => {
  it('validates syntax before starting and keeps paths literal', () => {
    expect(parseArguments(['add', '--', '-my checkout'])).toMatchObject({
      kind: 'add',
      path: '-my checkout',
    })
    expect(parseArguments(['pr', '123', '--no-open'])).toMatchObject({
      kind: 'pr',
      prNumber: 123,
      browser: 'none',
    })
    for (const args of [
      ['pr', '0'],
      ['pr', '1e3'],
      ['pr', '-1'],
      ['pr', '1.5'],
      ['pr', '9007199254740992'],
      ['add'],
      ['stop', '--open'],
      ['--open', '--no-open'],
      ['--backend', 'claude'],
    ])
      expect(() => parseArguments(args)).toThrow()
  })

  it('registers relative paths with cookie and Origin without opening a browser', async () => {
    const { d, fetcher } = fixture()
    await runCommand(parseArguments(['add', 'a repo']), d)
    expect(fetcher.mock.calls[1]).toEqual([
      'http://127.0.0.1:7777/api/repos',
      expect.objectContaining({
        body: JSON.stringify({ path: '/home/test/a repo' }),
        redirect: 'error',
        headers: expect.objectContaining({
          Cookie: 'legible_session=private-cookie',
          Origin: status.apiOrigin,
        }),
      }),
    ])
    expect(d.open).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(d.output).mock.calls)).not.toContain('private-token')
  })

  it('opens new PR settings without creating a session or calling an agent', async () => {
    const { d, fetcher } = fixture()
    await runCommand(parseArguments(['pr', '42']), d)
    expect(d.open).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/repos/owner/repo?pr=42#token=private-token',
    )
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/auth',
      '/api/repos',
      '/api/sessions',
    ])
    expect(fetcher.mock.calls[2]![1]?.method).toBeUndefined()
  })

  it('touches existing sessions, including receipts, without changing agent settings', async () => {
    const { d, fetcher } = fixture([
      { id: 'saved-id', repoId: repo.id, prNumber: 42, submission: { status: 'submitted' } },
    ])
    await runCommand(parseArguments(['pr', '42', '--no-open']), d)
    expect(String(fetcher.mock.calls.at(-1)![0]).endsWith('/api/sessions/saved-id/open')).toBe(true)
    expect(d.output).toHaveBeenCalledWith(expect.stringContaining('/review/saved-id#token='))
    expect(d.open).not.toHaveBeenCalled()
  })

  it('keeps home available outside a checkout but rejects PR entry there', async () => {
    const { d } = fixture([], true)
    await runCommand(parseArguments([]), d)
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('not registered'))
    expect(d.open).toHaveBeenCalledWith(`${status.webOrigin}/#token=private-token`)
    await expect(runCommand(parseArguments(['pr', '42']), d)).rejects.toThrow(
      'Not a supported checkout',
    )
  })

  it('status and stop never start a daemon or request a bootstrap token', async () => {
    const { d } = fixture()
    await runCommand(parseArguments(['status']), d)
    await runCommand(parseArguments(['stop']), d)
    expect(d.stop).toHaveBeenCalledWith(status)
    expect(d.ensure).not.toHaveBeenCalled()
    expect(d.connect).not.toHaveBeenCalled()
    vi.mocked(d.status).mockResolvedValue(undefined)
    await runCommand(parseArguments(['stop']), d)
    expect(d.output).toHaveBeenLastCalledWith('Legible is not running')
  })

  it('retains the URL when launching the browser fails without logging the error secret', async () => {
    const { d } = fixture()
    vi.mocked(d.open).mockRejectedValue(new Error('private-token in spawn argv'))
    await runCommand(parseArguments([]), d)
    expect(d.output).toHaveBeenCalledWith(expect.stringContaining('#token=private-token'))
    expect(JSON.stringify(vi.mocked(d.warn).mock.calls)).not.toContain('private-token')
  })

  it('uses explicit browser policy for SSH, CI, non-TTY, macOS and WSL', () => {
    expect(shouldOpenBrowser('auto', true, {})).toBe(true)
    for (const env of [
      { SSH_CONNECTION: 'x' },
      { SSH_CLIENT: 'x' },
      { SSH_TTY: 'x' },
      { CI: 'true' },
    ])
      expect(shouldOpenBrowser('auto', true, env)).toBe(false)
    expect(shouldOpenBrowser('auto', false, {})).toBe(false)
    expect(shouldOpenBrowser('open', false, { SSH_CONNECTION: 'x' })).toBe(true)
    expect(shouldOpenBrowser('none', true, {})).toBe(false)
    expect(browserCommand('linux', '6.1', {})).toBe('xdg-open')
    expect(browserCommand('linux', 'microsoft-standard-WSL2', {})).toBe('wslview')
    expect(browserCommand('darwin', 'Darwin', {})).toBe('open')
    expect(() => browserCommand('win32', '', {})).toThrow('WSL')
  })

  it('rejects incompatible versions and unexpected API addresses before sending credentials', () => {
    expect(() => assertCompatible(status, 'other')).toThrow('matching CLI')
    for (const apiOrigin of [
      'http://example.com:7777',
      'http://127.0.0.1:8888',
      'http://user@127.0.0.1:7777',
    ])
      expect(() => assertCompatible({ ...status, apiOrigin }, 'test')).toThrow()
  })
})
