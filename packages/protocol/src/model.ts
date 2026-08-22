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
  createdAt: string
}

export type DraftComment = {
  id: string
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
  body: string
  origin: 'claude' | 'codex' | 'human'
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
  backend: 'claude' | 'codex'
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
