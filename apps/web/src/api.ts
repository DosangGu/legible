import type {
  ApiError,
  ChatCommandAccepted,
  ChatSnapshot,
  CreateDraftCommentRequest,
  DraftComment,
  DiffDocument,
  DiffSide,
  ReviewFileContent,
  ReviewSession,
  SubmitReviewRequest,
  Repo,
  PullRequestPage,
  CreateSessionRequest,
  CreateSessionResponse,
  PreflightReport,
  ReviewUpdate,
  RefreshReviewResponse,
  CodeSearchResult,
} from '@legible/protocol'

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

export function fetchSession(sessionId: string, signal?: AbortSignal): Promise<ReviewSession> {
  return request<ReviewSession>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    ...(signal ? { signal } : {}),
  })
}

export function submitReview(
  sessionId: string,
  submission: SubmitReviewRequest,
  revision = 0,
): Promise<ReviewSession> {
  return request<ReviewSession>(`/api/sessions/${encodeURIComponent(sessionId)}/submission`, {
    method: 'POST',
    body: JSON.stringify(submission),
    headers: revisionHeaders(revision),
  })
}

export function reconcileSubmission(sessionId: string, revision = 0): Promise<ReviewSession> {
  return request<ReviewSession>(
    `/api/sessions/${encodeURIComponent(sessionId)}/submission/reconcile`,
    { method: 'POST', headers: revisionHeaders(revision) },
  )
}

export function cleanupSubmission(sessionId: string, revision = 0): Promise<ReviewSession> {
  return request<ReviewSession>(
    `/api/sessions/${encodeURIComponent(sessionId)}/submission/cleanup`,
    { method: 'POST', headers: revisionHeaders(revision) },
  )
}

export async function fetchSessionDiff(
  sessionId: string,
  signal?: AbortSignal,
  revision = 0,
): Promise<DiffDocument> {
  return request<DiffDocument>(`/api/sessions/${encodeURIComponent(sessionId)}/diff`, {
    headers: revisionHeaders(revision),
    ...(signal ? { signal } : {}),
  })
}

export async function fetchReviewFile(
  sessionId: string,
  path: string,
  side: DiffSide,
  signal?: AbortSignal,
  revision = 0,
): Promise<ReviewFileContent> {
  const query = new URLSearchParams({ path, side })
  return request<ReviewFileContent>(
    `/api/sessions/${encodeURIComponent(sessionId)}/file?${query.toString()}`,
    { ...(signal ? { signal } : {}), headers: revisionHeaders(revision) },
  )
}

export function fetchChat(
  sessionId: string,
  signal?: AbortSignal,
  revision = 0,
): Promise<ChatSnapshot> {
  return request<ChatSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    headers: revisionHeaders(revision),
    ...(signal ? { signal } : {}),
  })
}

export function searchCode(
  sessionId: string,
  query: string,
  revision: number,
  signal?: AbortSignal,
): Promise<CodeSearchResult> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/search?${new URLSearchParams({ q: query }).toString()}`,
    {
      headers: revisionHeaders(revision),
      ...(signal ? { signal } : {}),
    },
  )
}
export function fetchSearchFile(
  sessionId: string,
  path: string,
  revision: number,
  signal?: AbortSignal,
): Promise<ReviewFileContent> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/search/file?${new URLSearchParams({ path }).toString()}`,
    {
      headers: revisionHeaders(revision),
      ...(signal ? { signal } : {}),
    },
  )
}

export function startReview(sessionId: string, revision = 0): Promise<ChatCommandAccepted> {
  return chatCommand(sessionId, 'start', undefined, revision)
}

export function sendChatMessage(
  sessionId: string,
  message: string,
  itemId?: string,
  revision = 0,
): Promise<ChatCommandAccepted> {
  return chatCommand(sessionId, 'messages', { message, ...(itemId ? { itemId } : {}) }, revision)
}

export function interruptChat(sessionId: string, revision = 0): Promise<ChatCommandAccepted> {
  return chatCommand(sessionId, 'interrupt', undefined, revision)
}

export function retryChat(sessionId: string, revision = 0): Promise<ChatCommandAccepted> {
  return chatCommand(sessionId, 'retry', undefined, revision)
}

export function fetchComments(
  sessionId: string,
  signal?: AbortSignal,
  revision = 0,
): Promise<DraftComment[]> {
  return request<DraftComment[]>(`/api/sessions/${encodeURIComponent(sessionId)}/comments`, {
    headers: revisionHeaders(revision),
    ...(signal ? { signal } : {}),
  })
}

export function createComment(
  sessionId: string,
  comment: CreateDraftCommentRequest,
  revision = 0,
): Promise<DraftComment> {
  return request<DraftComment>(`/api/sessions/${encodeURIComponent(sessionId)}/comments`, {
    method: 'POST',
    body: JSON.stringify(comment),
    headers: revisionHeaders(revision),
  })
}

export function updateComment(
  sessionId: string,
  commentId: string,
  body: string,
  revision = 0,
): Promise<DraftComment> {
  return request<DraftComment>(
    `/api/sessions/${encodeURIComponent(sessionId)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'PATCH', body: JSON.stringify({ body }), headers: revisionHeaders(revision) },
  )
}

export async function deleteComment(
  sessionId: string,
  commentId: string,
  revision = 0,
): Promise<void> {
  await request<void>(
    `/api/sessions/${encodeURIComponent(sessionId)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE', headers: revisionHeaders(revision) },
  )
}

function chatCommand(
  sessionId: string,
  action: string,
  body?: unknown,
  revision = 0,
): Promise<ChatCommandAccepted> {
  return request<ChatCommandAccepted>(
    `/api/sessions/${encodeURIComponent(sessionId)}/chat/${action}`,
    {
      method: 'POST',
      headers: revisionHeaders(revision),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  )
}

export function fetchRepos(signal?: AbortSignal): Promise<Repo[]> {
  return request('/api/repos', signal ? { signal } : {})
}

export function checkReviewUpdates(session: ReviewSession): Promise<ReviewUpdate> {
  return request(`/api/sessions/${encodeURIComponent(session.id)}/updates`, {
    headers: revisionHeaders(session.reviewRevision ?? 0),
  })
}
export function refreshReview(session: ReviewSession): Promise<RefreshReviewResponse> {
  return request(`/api/sessions/${encodeURIComponent(session.id)}/refresh`, {
    method: 'POST',
    headers: revisionHeaders(session.reviewRevision ?? 0),
  })
}
export function reanchorComment(
  sessionId: string,
  id: string,
  anchor: Omit<CreateDraftCommentRequest, 'body'>,
  revision = 0,
): Promise<DraftComment> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/comments/${encodeURIComponent(id)}/reanchor`,
    { method: 'POST', body: JSON.stringify(anchor), headers: revisionHeaders(revision) },
  )
}
function revisionHeaders(revision: number) {
  return { 'x-legible-review-revision': String(revision) }
}
export function registerRepo(path: string): Promise<Repo> {
  return request('/api/repos', { method: 'POST', body: JSON.stringify({ path }) })
}
export function fetchSessions(signal?: AbortSignal): Promise<ReviewSession[]> {
  return request('/api/sessions', signal ? { signal } : {})
}
export function fetchPreflight(signal?: AbortSignal): Promise<PreflightReport> {
  return request('/api/preflight', signal ? { signal } : {})
}
export function refreshPreflight(): Promise<PreflightReport> {
  return request('/api/preflight/refresh', { method: 'POST' })
}
export function fetchPullRequests(
  owner: string,
  name: string,
  page: number,
  signal?: AbortSignal,
): Promise<PullRequestPage> {
  return request(
    `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?page=${String(page)}`,
    signal ? { signal } : {},
  )
}
export function openReview(input: CreateSessionRequest): Promise<CreateSessionResponse> {
  return request('/api/sessions', { method: 'POST', body: JSON.stringify(input) })
}
export function touchSession(id: string): Promise<ReviewSession> {
  return request(`/api/sessions/${encodeURIComponent(id)}/open`, { method: 'POST' })
}

export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
  })
  if (response.ok) {
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  let error: ApiError | undefined
  try {
    error = (await response.json()) as ApiError
  } catch {
    // The stable fallback below covers non-JSON proxy and daemon failures.
  }
  if (response.status === 401 && error?.error.code === 'browser_auth_required')
    window.dispatchEvent(new Event('legible:auth-required'))
  throw new ApiClientError(
    error?.error.message ?? `Request failed with status ${String(response.status)}`,
    response.status,
    error?.error.code ?? 'request_failed',
    error?.error.details,
  )
}
