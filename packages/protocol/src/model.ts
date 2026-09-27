export enum AgentBackendKind {
  Claude = 'claude',
  Codex = 'codex',
}

export type Repo = {
  id: string
  owner: string
  name: string
  checkouts: string[]
  primaryCheckout: string
}

export type RepositoryDetails = {
  repo: Repo
  checkouts: Array<{ path: string; available: boolean; message?: string }>
  sessionCount: number
  primaryChangeBlocked?: string
}

export type ReviewSession = {
  reviewRevision?: number
  baseTipSha?: string
  baseRef?: string
  worktreeGeneration?: string
  submissionHistory?: SubmittedReviewRecord[]
  id: string
  repoId: string
  prNumber: number
  headSha: string
  baseSha: string
  worktreePath: string
  config: ReviewConfig
  comments: DraftComment[]
  submission?: ReviewSubmission
  createdAt: string
  lastOpenedAt?: string
  archivedAt?: string
  deletionRequestedAt?: string
  pullRequest?: { title: string; url: string }
}

export type SubmittedReviewRecord = {
  reviewRevision: number
  headSha: string
  baseSha: string
  comments: DraftComment[]
  submission: Extract<ReviewSubmission, { status: 'submitted' }>
}

export type ReviewUpdate = {
  reviewRevision: number
  pinnedHeadSha: string
  headSha: string
  baseTipSha: string
  baseRef: string
  headChanged: boolean
  baseChanged: boolean | null
}
export type RefreshReviewResponse = { session: ReviewSession; changed: boolean; warning?: string }

export type PullRequestSummary = {
  number: number
  title: string
  url: string
  author: string
  baseRef: string
  headRef: string
  draft: boolean
  state: 'open' | 'closed'
  updatedAt: string
}

export type PullRequestPage = { items: PullRequestSummary[]; page: number; hasNextPage: boolean }
export type CreateSessionRequest = { repoId: string; prNumber: number; config: ReviewConfig }
export type CreateSessionResponse = { session: ReviewSession; reused: boolean }

export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'

export type ReviewSubmission =
  | {
      status: 'submitting' | 'uncertain'
      event: ReviewEvent
      body?: string
      marker: string
      startedAt: string
      currentHeadSha: string
      staleHead: boolean
    }
  | {
      status: 'submitted'
      event: ReviewEvent
      body?: string
      marker: string
      startedAt: string
      currentHeadSha: string
      staleHead: boolean
      githubReviewId: number
      htmlUrl: string
      submittedAt: string
      cleanup: {
        status: 'pending' | 'complete' | 'failed'
        message?: string
      }
    }

export type SubmitReviewRequest = {
  event: ReviewEvent
  body?: string
  allowStaleHead?: boolean
}

export type DraftComment = {
  anchorStatus?: 'current' | 'needs_review'
  anchorRevision?: number
  id: string
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
  body: string
  origin: AgentBackendKind | 'human'
  createdAt: string
}

export type CreateDraftCommentRequest = {
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
  body: string
}

export type UpdateDraftCommentRequest = {
  body: string
}

export type AgentSpec = {
  backend: AgentBackendKind
  model?: string
  effort?: string
  shell: 'none' | 'git' | 'broad'
  network: 'off' | 'fetch' | 'free'
  onOutOfScope: 'deny' | 'ask'
}

export type ReviewConfig = {
  main: AgentSpec
  assist?: AgentSpec
}
