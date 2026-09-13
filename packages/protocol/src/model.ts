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

export type ReviewSession = {
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
}

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
