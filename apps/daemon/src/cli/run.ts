import { resolve } from 'node:path'
import type { Repo, ReviewSession } from '@legible/protocol'
import type { CliCommand } from './arguments.js'
import { shouldOpenBrowser } from './browser.js'
import type { ControlStatus } from '../lifecycle/control.js'

export class DaemonApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export class DaemonClient {
  #cookie = ''
  constructor(
    private readonly origin: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async authenticate(token: string): Promise<void> {
    const response = await this.#send('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
    this.#cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
    if (!this.#cookie.startsWith('legible_session='))
      throw new Error('Legible did not establish browser authentication')
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.#send(
      path,
      body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) },
    )
    return response.json() as Promise<T>
  }

  async #send(path: string, options: RequestInit): Promise<Response> {
    const response = await this.fetcher(`${this.origin}${path}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Origin: this.origin,
        'Content-Type': 'application/json',
        ...(this.#cookie ? { Cookie: this.#cookie } : {}),
      },
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => undefined)) as
        { error?: { code?: string; message?: string } } | undefined
      throw new DaemonApiError(
        data?.error?.code ?? 'request_failed',
        data?.error?.message ?? `Legible request failed (${String(response.status)})`,
      )
    }
    return response
  }
}

export type CliDependencies = {
  cwd: string
  tty: boolean
  env: NodeJS.ProcessEnv
  ensure: () => Promise<ControlStatus>
  status: () => Promise<ControlStatus | undefined>
  connect: (status: ControlStatus) => Promise<string>
  stop: (status: ControlStatus) => Promise<void>
  client: (origin: string) => DaemonClient
  open: (url: string) => Promise<void>
  output: (message: string) => void
  warn: (message: string) => void
}

export async function runCommand(
  command: CliCommand,
  dependencies: CliDependencies,
): Promise<void> {
  const d = dependencies
  if (command.kind === 'status' || command.kind === 'stop') {
    const status = await d.status()
    if (!status) {
      d.output('Legible is not running')
      return
    }
    if (command.kind === 'status') {
      d.output(
        `Legible ${status.version}: ${status.phase}, PID ${String(status.pid)}, ${status.webOrigin}`,
      )
    } else {
      await d.stop(status)
      d.output('Legible stopped')
    }
    return
  }
  const status = await d.ensure()
  const token = await d.connect(status)
  const client = d.client(status.apiOrigin)
  await client.authenticate(token)
  let repo: Repo | undefined
  try {
    repo = await client.request<Repo>('/api/repos', { path: resolve(d.cwd, command.path ?? '.') })
  } catch (error) {
    const optionalRegistration = new Set([
      'invalid_repository',
      'repo_path_unavailable',
      'repo_path_forbidden',
      'unsupported_checkout',
      'unsupported_origin',
      'invalid_repo_id',
      'tools_not_ready',
    ])
    if (
      command.kind !== 'open' ||
      !(error instanceof DaemonApiError) ||
      !optionalRegistration.has(error.code)
    )
      throw error
    d.warn(`Current directory was not registered: ${error.message}`)
  }
  if (command.kind === 'add') {
    d.output(`Registered ${repo!.id}: ${repo!.primaryCheckout}`)
    return
  }
  let path = '/'
  if (command.kind === 'pr') {
    const sessions = await client.request<ReviewSession[]>('/api/sessions')
    const session = sessions.find(
      (item) =>
        item.repoId.toLowerCase() === repo!.id.toLowerCase() && item.prNumber === command.prNumber,
    )
    if (session) {
      await client.request(`/api/sessions/${encodeURIComponent(session.id)}/open`, {})
      path = `/review/${encodeURIComponent(session.id)}`
    } else
      path = `/repos/${encodeURIComponent(repo!.owner)}/${encodeURIComponent(repo!.name)}?pr=${String(command.prNumber)}`
  }
  const url = `${status.webOrigin}${path}#token=${encodeURIComponent(token)}`
  d.output(`Open Legible: ${url}`)
  if (shouldOpenBrowser(command.browser, d.tty, d.env)) {
    try {
      await d.open(url)
    } catch {
      d.warn('Unable to open the browser. Open the printed URL manually (WSL needs wslview).')
    }
  }
}
