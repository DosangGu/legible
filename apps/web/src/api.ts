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
): Promise<ReviewSession> {
  return request<ReviewSession>(`/api/sessions/${encodeURIComponent(sessionId)}/submission`, {
    method: 'POST',
    body: JSON.stringify(submission),
  })
}

export function reconcileSubmission(sessionId: string): Promise<ReviewSession> {
  return request<ReviewSession>(
    `/api/sessions/${encodeURIComponent(sessionId)}/submission/reconcile`,
    { method: 'POST' },
  )
}

export function cleanupSubmission(sessionId: string): Promise<ReviewSession> {
  return request<ReviewSession>(
    `/api/sessions/${encodeURIComponent(sessionId)}/submission/cleanup`,
    { method: 'POST' },
  )
}

export async function fetchSessionDiff(
  sessionId: string,
  signal?: AbortSignal,
): Promise<DiffDocument> {
  return request<DiffDocument>(`/api/sessions/${encodeURIComponent(sessionId)}/diff`, {
    ...(signal ? { signal } : {}),
  })
}

export async function fetchReviewFile(
  sessionId: string,
  path: string,
  side: DiffSide,
  signal?: AbortSignal,
): Promise<ReviewFileContent> {
  const query = new URLSearchParams({ path, side })
  return request<ReviewFileContent>(
    `/api/sessions/${encodeURIComponent(sessionId)}/file?${query.toString()}`,
    { ...(signal ? { signal } : {}) },
  )
}

export function fetchChat(sessionId: string, signal?: AbortSignal): Promise<ChatSnapshot> {
  return request<ChatSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    ...(signal ? { signal } : {}),
  })
}

export function startReview(sessionId: string): Promise<ChatCommandAccepted> {
  return chatCommand(sessionId, 'start')
}

export function sendChatMessage(sessionId: string, message: string): Promise<ChatCommandAccepted> {
  return chatCommand(sessionId, 'messages', { message })
}

export function interruptChat(sessionId: string): Promise<ChatCommandAccepted> {
  return chatCommand(sessionId, 'interrupt')
}

export function retryChat(sessionId: string): Promise<ChatCommandAccepted> {
  return chatCommand(sessionId, 'retry')
}

export function fetchComments(sessionId: string, signal?: AbortSignal): Promise<DraftComment[]> {
  return request<DraftComment[]>(`/api/sessions/${encodeURIComponent(sessionId)}/comments`, {
    ...(signal ? { signal } : {}),
  })
}

export function createComment(
  sessionId: string,
  comment: CreateDraftCommentRequest,
): Promise<DraftComment> {
  return request<DraftComment>(`/api/sessions/${encodeURIComponent(sessionId)}/comments`, {
    method: 'POST',
    body: JSON.stringify(comment),
  })
}

export function updateComment(
  sessionId: string,
  commentId: string,
  body: string,
): Promise<DraftComment> {
  return request<DraftComment>(
    `/api/sessions/${encodeURIComponent(sessionId)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'PATCH', body: JSON.stringify({ body }) },
  )
}

export async function deleteComment(sessionId: string, commentId: string): Promise<void> {
  await request<void>(
    `/api/sessions/${encodeURIComponent(sessionId)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE' },
  )
}

function chatCommand(
  sessionId: string,
  action: string,
  body?: unknown,
): Promise<ChatCommandAccepted> {
  return request<ChatCommandAccepted>(
    `/api/sessions/${encodeURIComponent(sessionId)}/chat/${action}`,
    {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  )
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
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
  throw new ApiClientError(
    error?.error.message ?? `Request failed with status ${String(response.status)}`,
    response.status,
    error?.error.code ?? 'request_failed',
    error?.error.details,
  )
}
