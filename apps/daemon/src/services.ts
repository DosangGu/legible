import type { PreflightReport } from '@legible/protocol'

import { CodexBackend } from './agents/codex/backend.js'
import type { AppServerProcessFactory } from './agents/codex/app-server-client.js'
import type { AgentBackend, McpServerProvider } from './agents/types.js'
import { ChatService } from './chats/service.js'
import { CommentService } from './comments/service.js'
import { SessionFileService } from './diffs/file-service.js'
import { NodeGitFileSource, type FileSource } from './diffs/file-source.js'
import { SessionDiffService } from './diffs/service.js'
import { NodeGitDiffSource, type DiffSource } from './diffs/source.js'
import { EventBus } from './events/event-bus.js'
import { OctokitGitHubClient, type GitHubClient } from './github/client.js'
import { ReviewMcpServer } from './mcp/server.js'
import { NodeCommandRunner, type CommandRunner } from './preflight/command-runner.js'
import { PreflightService } from './preflight/service.js'
import { SessionRegistry } from './sessions/session-registry.js'
import { SessionPersistence } from './sessions/persistence.js'
import { SessionMutationQueue } from './sessions/mutation-queue.js'
import { SessionStore } from './sessions/store.js'
import { WorktreeService } from './worktrees/service.js'
import { SubmissionService } from './submissions/service.js'

export type DaemonServices = {
  repoPath: string
  agents: {
    codex: AgentBackend
  }
  chats: ChatService
  comments: CommentService
  mcp: ReviewMcpServer
  eventBus: EventBus
  diffs: SessionDiffService
  files: SessionFileService
  preflight: PreflightService
  sessions: SessionRegistry
  persistence: SessionPersistence
  submissions: SubmissionService
  worktrees: WorktreeService
}

export type CreateServicesOptions = {
  repoPath: string
  runner?: CommandRunner
  diffSource?: DiffSource
  fileSource?: FileSource
  stateDirectory?: string
  worktreeTtlMs?: number
  now?: () => Date
  onListenerError?: (error: unknown) => void
  codexProcessFactory?: AppServerProcessFactory
  codexBackend?: AgentBackend
  githubClient?: GitHubClient
  mcpOrigin?: string
}

export function createDaemonServices(options: CreateServicesOptions): DaemonServices {
  const runner = options.runner ?? new NodeCommandRunner()
  const eventBus = new EventBus({
    ...(options.now ? { now: options.now } : {}),
    ...(options.onListenerError ? { onListenerError: options.onListenerError } : {}),
  })
  const sessions = new SessionRegistry(eventBus)
  const diffs = new SessionDiffService(options.diffSource ?? new NodeGitDiffSource())
  const files = new SessionFileService(diffs, options.fileSource ?? new NodeGitFileSource())
  const publishPreflight = (report: PreflightReport) => {
    eventBus.publish({ type: 'preflight.updated', payload: report })
  }
  const preflight = new PreflightService(runner, {
    ...(options.now ? { now: options.now } : {}),
    onUpdated: publishPreflight,
  })
  const worktrees = new WorktreeService({
    repoPath: options.repoPath,
    runner,
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(options.worktreeTtlMs !== undefined ? { ttlMs: options.worktreeTtlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const codex =
    options.codexBackend ??
    new CodexBackend({
      ...(options.codexProcessFactory ? { processFactory: options.codexProcessFactory } : {}),
    })
  const mcpHolder: { server?: ReviewMcpServer } = {}
  const mcpProvider: McpServerProvider = {
    open(sessionId, origin) {
      if (!mcpHolder.server) throw new Error('Legible MCP server is not ready')
      return mcpHolder.server.open(sessionId, origin)
    },
  }
  const chats = new ChatService({
    sessions,
    diffs,
    eventBus,
    codex,
    mcp: mcpProvider,
    ...(options.now ? { now: options.now } : {}),
  })
  const persistence = new SessionPersistence(
    new SessionStore(options.stateDirectory),
    sessions,
    chats,
    eventBus,
  )
  const mutations = new SessionMutationQueue()
  const comments = new CommentService(
    sessions,
    diffs,
    persistence,
    mutations,
    options.now ?? (() => new Date()),
  )
  const reviewMcp = new ReviewMcpServer({
    origin: options.mcpOrigin ?? 'http://127.0.0.1:7777',
    sessions,
    comments,
    eventBus,
  })
  mcpHolder.server = reviewMcp
  const submissions = new SubmissionService(
    sessions,
    persistence,
    mutations,
    comments,
    chats,
    worktrees,
    options.githubClient ?? new OctokitGitHubClient(runner),
    options.now ?? (() => new Date()),
  )

  return {
    repoPath: options.repoPath,
    agents: { codex },
    chats,
    comments,
    mcp: reviewMcp,
    diffs,
    eventBus,
    files,
    preflight,
    persistence,
    sessions,
    submissions,
    worktrees,
  }
}
