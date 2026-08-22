import type { PreflightCheck, PreflightReport, PreflightTool } from '@legible/protocol'

import type { CommandResult, CommandRunner } from './command-runner.js'

const commandTimeoutMs = 5_000

type ToolDefinition = {
  tool: PreflightTool
  version: readonly [command: string, ...args: string[]]
  auth?: readonly [command: string, ...args: string[]]
}

const tools: readonly ToolDefinition[] = [
  { tool: 'git', version: ['git', '--version'] },
  { tool: 'gh', version: ['gh', '--version'], auth: ['gh', 'auth', 'status'] },
  {
    tool: 'claude',
    version: ['claude', '--version'],
    auth: ['claude', 'auth', 'status'],
  },
  {
    tool: 'codex',
    version: ['codex', '--version'],
    auth: ['codex', 'login', 'status'],
  },
]

export type PreflightServiceOptions = {
  now?: () => Date
  onUpdated?: (report: PreflightReport) => void
}

export class PreflightNotReadyError extends Error {
  constructor() {
    super('Required tools are not ready')
    this.name = 'PreflightNotReadyError'
  }
}

export class PreflightService {
  readonly #now: () => Date
  readonly #onUpdated: (report: PreflightReport) => void
  #report: PreflightReport
  #refreshing: Promise<PreflightReport> | undefined

  constructor(
    private readonly runner: CommandRunner,
    options: PreflightServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date())
    this.#onUpdated = options.onUpdated ?? (() => undefined)
    this.#report = {
      status: 'degraded',
      checkedAt: this.#now().toISOString(),
      checks: tools.map(({ tool }) => ({
        tool,
        status: 'error',
        message: 'Check has not run',
      })),
    }
  }

  getReport(): PreflightReport {
    return structuredClone(this.#report)
  }

  assertReady(): void {
    if (this.#report.status !== 'ready') throw new PreflightNotReadyError()
  }

  refresh(): Promise<PreflightReport> {
    if (this.#refreshing) return this.#refreshing

    this.#refreshing = this.#runChecks()
      .then((report) => {
        this.#report = report
        const snapshot = structuredClone(report)
        this.#onUpdated(snapshot)
        return structuredClone(snapshot)
      })
      .finally(() => {
        this.#refreshing = undefined
      })

    return this.#refreshing
  }

  async #runChecks(): Promise<PreflightReport> {
    const checks = await Promise.all(tools.map((definition) => this.#checkTool(definition)))

    return {
      status: checks.every(({ status }) => status === 'ready') ? 'ready' : 'degraded',
      checkedAt: this.#now().toISOString(),
      checks,
    }
  }

  async #checkTool(definition: ToolDefinition): Promise<PreflightCheck> {
    const versionResult = await this.#run(definition.version)
    if (versionResult.status !== 'completed' || versionResult.exitCode !== 0) {
      return failureForVersion(definition.tool, versionResult)
    }

    const version = firstLine(versionResult.stdout)
    if (!definition.auth) {
      return version
        ? { tool: definition.tool, status: 'ready', version }
        : {
            tool: definition.tool,
            status: 'ready',
          }
    }

    const authResult = await this.#run(definition.auth)
    if (authResult.status === 'completed' && authResult.exitCode === 0) {
      return version
        ? { tool: definition.tool, status: 'ready', version }
        : {
            tool: definition.tool,
            status: 'ready',
          }
    }

    const status = authResult.status === 'completed' ? 'unauthenticated' : 'error'
    const message =
      authResult.status === 'timed_out'
        ? 'Authentication check timed out'
        : status === 'unauthenticated'
          ? 'Authentication required'
          : 'Authentication check failed'

    return version
      ? { tool: definition.tool, status, version, message }
      : { tool: definition.tool, status, message }
  }

  #run(command: readonly [string, ...string[]]): Promise<CommandResult> {
    const [executable, ...args] = command
    return this.runner.run(executable, args, { timeoutMs: commandTimeoutMs })
  }
}

function failureForVersion(tool: PreflightTool, result: CommandResult): PreflightCheck {
  if (result.status === 'missing') {
    return { tool, status: 'missing', message: 'Executable not found' }
  }

  if (result.status === 'timed_out') {
    return { tool, status: 'error', message: 'Version check timed out' }
  }

  return { tool, status: 'error', message: 'Version check failed' }
}

function firstLine(value: string): string | undefined {
  const line = value
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find(Boolean)

  return line?.slice(0, 200)
}
