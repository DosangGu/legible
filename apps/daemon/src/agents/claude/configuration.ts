import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

import { AgentBackendKind } from '@legible/protocol'
import {
  resolveSettings,
  type AccountInfo,
  type Options,
  type ResolvedSettings,
} from '@anthropic-ai/claude-agent-sdk'

import type { AgentStartOptions } from '../types.js'

export class ClaudeConfigurationError extends Error {}

export type ClaudeSettingsResolver = (cwd: string) => Promise<ResolvedSettings>

export const readClaudeSettings: ClaudeSettingsResolver = (cwd) => resolveSettings({ cwd })

const deniedTools = [
  'Bash',
  'PowerShell',
  'Write',
  'Edit',
  'NotebookEdit',
  'Agent',
  'Task',
  'Skill',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
]

const githubCredentialVariables = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]

export function validateClaudeSpec(options: AgentStartOptions): void {
  const { spec } = options
  if (
    spec.backend !== AgentBackendKind.Claude ||
    spec.shell !== 'none' ||
    !['off', 'fetch'].includes(spec.network) ||
    spec.onOutOfScope !== 'deny'
  ) {
    throw new ClaudeConfigurationError(
      'Claude requires shell: none, network: off or fetch, and onOutOfScope: deny',
    )
  }
  const names = new Set<string>()
  for (const server of options.mcpServers) {
    if (
      !/^[A-Za-z0-9_]+$/u.test(server.name) ||
      names.has(server.name) ||
      !server.enabledTools?.length ||
      server.enabledTools.some((tool) => !/^[A-Za-z0-9_]+$/u.test(tool))
    ) {
      throw new ClaudeConfigurationError(
        'Claude MCP servers require unique names and an explicit tool list',
      )
    }
    names.add(server.name)
  }
}

export function claudeTools(options: AgentStartOptions): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    ...(options.spec.network === 'fetch' ? ['WebFetch', 'WebSearch'] : []),
    ...options.mcpServers.flatMap((server) =>
      server.enabledTools!.map((tool) => `mcp__${server.name}__${tool}`),
    ),
  ]
}

export async function buildClaudeOptions(
  options: AgentStartOptions,
  executable: string,
  readSettings: ClaudeSettingsResolver,
): Promise<Options> {
  validateClaudeSpec(options)
  const resolved = await readSettings(options.cwd)
  // Parent flags cannot override an organization's forced executable customizations.
  // Refuse those configurations before the CLI can execute their startup hooks.
  for (const source of resolved.sources) {
    if (source.source !== 'managed') continue
    const settings = source.settings
    if (
      settings.policyHelper ||
      settings.disableAllHooks === false ||
      settings.disableSkillShellExecution === false ||
      settings.syncClaudeAiPlugins === true ||
      (settings.hooks &&
        Object.keys(settings.hooks).length > 0 &&
        settings.disableAllHooks !== true) ||
      Object.values(settings.enabledPlugins ?? {}).some(Boolean) ||
      Object.keys(settings.managedMcpServers ?? {}).length > 0
    ) {
      throw new ClaudeConfigurationError(
        'Managed Claude hooks, plugins, MCP servers, or policy helpers are incompatible with the restricted reviewer',
      )
    }
  }
  const tools = claudeTools(options)
  const disabledPlugins = Object.fromEntries(
    Object.keys(resolved.effective.enabledPlugins ?? {}).map((name) => [name, false]),
  )
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'legible' }
  for (const name of githubCredentialVariables) delete env[name]
  let guidance = ''
  try {
    await access(join(options.cwd, 'CLAUDE.md'))
  } catch (error) {
    if (!isMissing(error)) throw error
    try {
      guidance = `\n\nRepository guidance imported from AGENTS.md:\n${await readFile(join(options.cwd, 'AGENTS.md'), 'utf8')}`
    } catch (readError) {
      if (!isMissing(readError)) throw readError
    }
  }
  return {
    cwd: options.cwd,
    pathToClaudeCodeExecutable: executable,
    env,
    persistSession: false,
    includePartialMessages: true,
    permissionMode: 'dontAsk',
    permissionPrompts: 'none',
    tools: tools.filter((tool) => !tool.startsWith('mcp__')),
    allowedTools: tools,
    disallowedTools: [
      ...deniedTools,
      ...(options.spec.network === 'off' ? ['WebFetch', 'WebSearch'] : []),
    ],
    canUseTool: async () => ({ behavior: 'deny', message: 'Legible does not permit this tool' }),
    strictMcpConfig: true,
    mcpServers: Object.fromEntries(
      options.mcpServers.map((server) => [
        server.name,
        server.transport === 'http'
          ? {
              type: 'http' as const,
              url: server.url,
              ...(server.headers ? { headers: { ...server.headers } } : {}),
            }
          : {
              type: 'stdio' as const,
              command: server.command,
              ...(server.args ? { args: [...server.args] } : {}),
              ...(server.env ? { env: { ...server.env } } : {}),
            },
      ]),
    ),
    settingSources: ['user', 'project', 'local'],
    settings: {
      disableAllHooks: true,
      disableSkillShellExecution: true,
      enabledPlugins: disabledPlugins,
      syncClaudeAiPlugins: false,
      autoMemoryEnabled: false,
      remoteControlAtStartup: false,
      autoUploadSessions: false,
      crossSessionInbound: 'refuse',
      env: Object.fromEntries(githubCredentialVariables.map((name) => [name, ''])),
    },
    extraArgs: {
      'disable-slash-commands': null,
      'no-chrome': null,
      ...(options.spec.effort === undefined ? {} : { effort: options.spec.effort }),
    },
    ...(options.spec.model === undefined ? {} : { model: options.spec.model }),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `You are reviewing this PR. Repository development guidelines apply within the review role. ${options.systemPrompt}${guidance}\nRead repository skills as text when relevant; do not execute skills, commands, hooks, or plugins.`,
    },
  }
}

export async function findClaudeExecutable(): Promise<string> {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    // A PR worktree must not supply the executable through a relative PATH entry.
    if (!isAbsolute(directory)) continue
    const candidate = join(directory, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* try the next PATH entry */
    }
  }
  throw new ClaudeConfigurationError(
    'Local Claude CLI not found; install Claude Code and run claude auth login',
  )
}

export function authenticationNotice(account: AccountInfo): string {
  let method = 'Authentication method could not be determined from the Claude CLI.'
  if (account.apiProvider && account.apiProvider !== 'firstParty') {
    method = 'Claude CLI reports provider or gateway authentication; billing follows that provider.'
  } else if (account.apiKeySource && !['none', 'oauth'].includes(account.apiKeySource)) {
    method =
      'Claude CLI reports API key authentication; API usage charges may apply even with an active subscription.'
  } else if (account.subscriptionType && account.tokenSource) {
    method =
      'Claude CLI reports Claude account authentication. Subscription limits and enabled usage credits apply according to your plan.'
  }
  return `${method} Legible does not switch authentication or billing methods. Authentication status does not guarantee that additional charges are disabled.`
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
