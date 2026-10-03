import { AgentBackendKind } from '../model.js'
import type * as Protocol from '../index.js'

const createdAt = '2026-10-03T00:00:00.000Z'
const config = {
  main: {
    backend: AgentBackendKind.Codex,
    model: 'future-model',
    effort: 'future-effort',
    shell: 'broad',
    network: 'free',
    onOutOfScope: 'ask',
  },
  assist: {
    backend: AgentBackendKind.Claude,
    shell: 'none',
    network: 'fetch',
    onOutOfScope: 'deny',
  },
} satisfies Protocol.ReviewConfig

const repo = {
  id: 'owner/repo',
  owner: 'owner',
  name: 'repo',
  checkouts: ['/projects/repo'],
  primaryCheckout: '/projects/repo',
} satisfies Protocol.Repo

const comments = [
  {
    id: 'human',
    path: 'src/한 글.rs',
    line: 4,
    side: 'RIGHT',
    body: '확인',
    origin: 'human',
    createdAt,
  },
  {
    id: 'codex',
    path: 'src/한 글.rs',
    line: 6,
    side: 'LEFT',
    startLine: 4,
    startSide: 'LEFT',
    body: 'Original behavior',
    origin: AgentBackendKind.Codex,
    createdAt,
    anchorStatus: 'current',
    anchorRevision: 0,
  },
  {
    id: 'claude',
    path: 'src/old.rs',
    line: 3,
    side: 'RIGHT',
    body: 'Locate again',
    origin: AgentBackendKind.Claude,
    createdAt,
    anchorStatus: 'needs_review',
    anchorRevision: 1,
  },
] satisfies Protocol.DraftComment[]

const pending = {
  event: 'COMMENT',
  marker: 'legible:test',
  startedAt: createdAt,
  currentHeadSha: 'head',
  staleHead: false,
} as const
const submitted = {
  ...pending,
  status: 'submitted',
  body: '',
  githubReviewId: 42,
  htmlUrl: 'https://github.com/owner/repo/pull/1#pullrequestreview-42',
  submittedAt: createdAt,
  cleanup: { status: 'complete' },
} satisfies Extract<Protocol.ReviewSubmission, { status: 'submitted' }>

const minimalSession = {
  id: 'minimal',
  repoId: repo.id,
  prNumber: 1,
  headSha: 'head',
  baseSha: 'base',
  worktreePath: '/state/worktrees/minimal',
  reviewRevision: 0,
  config: {
    main: { backend: AgentBackendKind.Codex, shell: 'git', network: 'off', onOutOfScope: 'deny' },
  },
  comments: [],
  createdAt,
} satisfies Protocol.ReviewSession
const session = {
  ...minimalSession,
  id: 'review',
  config,
  comments,
  reviewRevision: 2,
  baseTipSha: 'tip',
  baseRef: 'main',
  worktreeGeneration: 'generation-2',
  submissionHistory: [
    {
      reviewRevision: 1,
      headSha: 'old-head',
      baseSha: 'base',
      comments: [],
      submission: submitted,
    },
  ],
  submission: { ...pending, status: 'uncertain' },
  lastOpenedAt: createdAt,
  archivedAt: createdAt,
  deletionRequestedAt: createdAt,
  pullRequest: { title: 'Review title', url: 'https://github.com/owner/repo/pull/1' },
} satisfies Protocol.ReviewSession

const preflight = {
  status: 'degraded',
  checkedAt: createdAt,
  checks: [
    { tool: 'git', status: 'ready', version: 'git test' },
    { tool: 'gh', status: 'unauthenticated', message: 'Sign in' },
    { tool: AgentBackendKind.Claude, status: 'missing' },
    { tool: AgentBackendKind.Codex, status: 'error', version: '', message: 'Unavailable' },
  ],
} satisfies Protocol.PreflightReport
const usage = {
  inputTokens: 10,
  cachedInputTokens: 2,
  outputTokens: 3,
  reasoningOutputTokens: 1,
  totalTokens: 14,
} satisfies Protocol.ChatUsage
const entryBase = { turnId: 'turn-1', createdAt }
const entries = [
  { ...entryBase, id: 'user', kind: 'message', role: 'user', text: '' },
  {
    ...entryBase,
    id: 'assistant',
    itemId: 'human',
    kind: 'message',
    role: 'assistant',
    text: '설명',
  },
  {
    ...entryBase,
    id: 'running',
    kind: 'tool',
    name: 'list_comments',
    status: 'running',
    input: '{}',
  },
  {
    ...entryBase,
    id: 'completed',
    itemId: 'human',
    kind: 'tool',
    callId: 'call-1',
    name: 'list_comments',
    status: 'completed',
    input: '{}',
    output: '[]',
  },
  {
    ...entryBase,
    id: 'failed',
    kind: 'tool',
    name: 'focus',
    status: 'failed',
    input: '{}',
    output: '',
  },
  { ...entryBase, id: 'info', kind: 'notice', level: 'info', message: 'Ready', retryable: false },
  {
    ...entryBase,
    id: 'error',
    itemId: 'human',
    kind: 'notice',
    scope: 'session',
    level: 'error',
    message: 'Retry',
    retryable: true,
  },
] satisfies Protocol.ChatEntry[]

const chatEvents = [
  { type: 'status', status: 'idle' },
  {
    type: 'status',
    status: 'running',
    currentTurnId: 'turn-1',
    currentItemId: 'human',
    retryItemId: 'claude',
  },
  ...entries.map((entry): Protocol.ChatStreamEvent => ({ type: 'entry.added', entry })),
  { type: 'assistant.delta', entryId: 'assistant', text: '한 글\n' },
  { type: 'tool.completed', entryId: 'completed', status: 'completed', output: '[]' },
  { type: 'tool.completed', entryId: 'failed', status: 'failed', output: '' },
  { type: 'usage', usage },
] satisfies Protocol.ChatStreamEvent[]
const focus = {
  sessionId: 'review',
  path: 'src/한 글.rs',
  line: 6,
  side: 'LEFT',
  startLine: 4,
} satisfies Protocol.ReviewFocusRequest
const daemonEvents = [
  { type: 'daemon.snapshot', payload: { preflight, sessions: [] } },
  { type: 'preflight.updated', payload: preflight },
  { type: 'repo.updated', payload: repo },
  { type: 'repo.removed', payload: { id: repo.id } },
  { type: 'session.added', payload: minimalSession },
  { type: 'session.updated', payload: session },
  { type: 'session.removed', payload: { id: 'minimal' } },
  { type: 'review.focus.requested', payload: focus },
  ...chatEvents.map((event): Protocol.DaemonEvent => ({
    type: 'chat.event',
    payload: { sessionId: 'review', revision: 0, event },
  })),
] satisfies Protocol.DaemonEvent[]
const pullRequest = {
  number: 1,
  title: 'Review title',
  url: 'https://github.com/owner/repo/pull/1',
  author: 'author',
  baseRef: 'main',
  headRef: 'feature',
  draft: false,
  state: 'open',
  updatedAt: createdAt,
} satisfies Protocol.PullRequestSummary

// Type-checked against the current protocol. The checked-in JSON is shared with Rust tests.
export const wireFixtures = {
  repos: [repo],
  repositoryDetails: [
    { repo, checkouts: [{ path: '/projects/repo', available: true }], sessionCount: 0 },
    {
      repo,
      checkouts: [{ path: '/projects/repo', available: false, message: 'Moved' }],
      sessionCount: 2,
      primaryChangeBlocked: 'Saved reviews',
    },
  ] satisfies Protocol.RepositoryDetails[],
  health: [
    { status: 'ready', version: '0.0.0', uptimeSeconds: 0 },
    { status: 'degraded', version: '0.0.0', uptimeSeconds: 12 },
  ] satisfies Protocol.DaemonHealth[],
  preflight: [
    preflight,
    { status: 'ready', checkedAt: createdAt, checks: [] },
  ] satisfies Protocol.PreflightReport[],
  sessions: [minimalSession, session] satisfies Protocol.ReviewSession[],
  submissions: [
    { ...pending, status: 'submitting' },
    {
      ...pending,
      status: 'uncertain',
      event: 'REQUEST_CHANGES',
      body: 'Investigate',
      staleHead: true,
    },
    submitted,
    { ...submitted, event: 'APPROVE', cleanup: { status: 'pending' } },
    { ...submitted, cleanup: { status: 'failed', message: 'Dirty worktree' } },
  ] satisfies Protocol.ReviewSubmission[],
  reviewUpdates: [null, false, true].map((baseChanged): Protocol.ReviewUpdate => ({
    reviewRevision: 0,
    pinnedHeadSha: 'head',
    headSha: 'next-head',
    baseTipSha: 'tip',
    baseRef: 'main',
    headChanged: true,
    baseChanged,
  })),
  diffs: [
    {
      baseSha: 'base',
      headSha: 'head',
      additions: 1,
      deletions: 1,
      files: [
        {
          oldPath: null,
          newPath: 'new.rs',
          status: 'added',
          isBinary: false,
          additions: 0,
          deletions: 0,
          hunks: [],
        },
        {
          oldPath: 'gone.png',
          newPath: null,
          status: 'deleted',
          isBinary: true,
          additions: 0,
          deletions: 0,
          hunks: [],
        },
        {
          oldPath: 'old.rs',
          newPath: 'renamed.rs',
          status: 'renamed',
          isBinary: false,
          oldMode: '100644',
          newMode: '100755',
          additions: 0,
          deletions: 0,
          hunks: [],
        },
        {
          oldPath: 'src/한 글.rs',
          newPath: 'src/한 글.rs',
          status: 'modified',
          isBinary: false,
          additions: 1,
          deletions: 1,
          hunks: [
            {
              oldStart: 4,
              oldLines: 2,
              newStart: 4,
              newLines: 2,
              heading: 'fn main()',
              lines: [
                {
                  kind: 'context',
                  content: 'same',
                  leftLine: 4,
                  rightLine: 4,
                  noNewlineAtEnd: false,
                },
                {
                  kind: 'deletion',
                  content: 'old',
                  leftLine: 5,
                  rightLine: null,
                  noNewlineAtEnd: false,
                },
                {
                  kind: 'addition',
                  content: '새 값',
                  leftLine: null,
                  rightLine: 5,
                  noNewlineAtEnd: true,
                },
              ],
            },
            { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [] },
          ],
        },
      ],
    },
  ] satisfies Protocol.DiffDocument[],
  reviewFiles: [
    { path: 'gone.png', side: 'LEFT', sha: 'base', content: null, isBinary: true, byteLength: 12 },
    { path: 'new.rs', side: 'RIGHT', sha: 'head', content: '', isBinary: false, byteLength: 0 },
  ] satisfies Protocol.ReviewFileContent[],
  directories: [
    {
      root: '/projects',
      path: '/projects',
      repository: false,
      entries: [{ name: 'repo', path: '/projects/repo', repository: true }],
      truncated: false,
    },
    {
      root: '/projects',
      path: '/projects/repo',
      parent: '/projects',
      repository: true,
      entries: [],
      truncated: true,
    },
  ] satisfies Protocol.DirectoryListing[],
  searches: [
    {
      reviewRevision: 0,
      headSha: 'head',
      query: '한 글',
      matches: [{ path: 'src/한 글.rs', line: 5, preview: '한 글' }],
      truncated: true,
      skippedLargeFiles: 1,
    },
  ] satisfies Protocol.CodeSearchResult[],
  errors: [
    { error: { code: 'session_not_found', message: 'Unknown review' } },
    {
      error: {
        code: 'revision_conflict',
        message: 'Refresh',
        details: { revision: 0, received: null, values: [false, '', { path: 'src/한 글.rs' }] },
      },
    },
  ] satisfies Protocol.ApiError[],
  chats: [
    ...(['unavailable', 'idle', 'starting', 'running', 'interrupting', 'failed'] as const).map(
      (status): Protocol.ChatSnapshot => ({
        sessionId: 'review',
        revision: 0,
        status,
        backend: AgentBackendKind.Codex,
        entries: [],
      }),
    ),
    {
      sessionId: 'review',
      revision: 1,
      status: 'running',
      backend: AgentBackendKind.Claude,
      entries,
      reviewPending: false,
      model: 'future-model',
      unavailableReason: '',
      currentTurnId: 'turn-1',
      currentItemId: 'human',
      retryItemId: 'claude',
      lastUsage: usage,
    },
  ] satisfies Protocol.ChatSnapshot[],
  events: daemonEvents.map((event, sequence): Protocol.DaemonEventEnvelope => ({
    ...event,
    sequence,
    emittedAt: createdAt,
  })),
  focusRequests: [
    focus,
    { sessionId: 'review', path: 'new.rs', line: 1, side: 'RIGHT' },
  ] satisfies Protocol.ReviewFocusRequest[],
  createSessionRequests: [
    { repoId: repo.id, prNumber: 1, config },
  ] satisfies Protocol.CreateSessionRequest[],
  createSessionResponses: [
    { session: minimalSession, reused: false },
  ] satisfies Protocol.CreateSessionResponse[],
  refreshResponses: [
    { session: minimalSession, changed: false },
    { session: minimalSession, changed: true, warning: 'Retained worktree' },
  ] satisfies Protocol.RefreshReviewResponse[],
  pullRequests: [
    pullRequest,
    { ...pullRequest, state: 'closed', draft: true },
  ] satisfies Protocol.PullRequestSummary[],
  pullRequestPages: [
    { items: [pullRequest], page: 1, hasNextPage: false },
  ] satisfies Protocol.PullRequestPage[],
  createCommentRequests: [
    { path: 'new.rs', line: 1, side: 'RIGHT', body: '' },
    {
      path: 'src/한 글.rs',
      line: 6,
      side: 'LEFT',
      startLine: 4,
      startSide: 'LEFT',
      body: 'Original behavior',
    },
  ] satisfies Protocol.CreateDraftCommentRequest[],
  updateCommentRequests: [
    { body: 'Updated comment' },
  ] satisfies Protocol.UpdateDraftCommentRequest[],
  submitRequests: [
    { event: 'COMMENT' },
    { event: 'APPROVE', body: '', allowStaleHead: false },
    { event: 'REQUEST_CHANGES', allowStaleHead: true },
  ] satisfies Protocol.SubmitReviewRequest[],
  chatCommands: [
    { sessionId: 'review', turnId: 'turn-1', revision: 0 },
    { sessionId: 'review', turnId: 'turn-1', revision: 1, itemId: 'human' },
  ] satisfies Protocol.ChatCommandAccepted[],
}
