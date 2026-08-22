import type { ApiError, DiffDocument, DiffSide, ReviewFileContent } from '@legible/protocol'

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

export async function fetchSessionDiff(
  sessionId: string,
  signal?: AbortSignal,
): Promise<DiffDocument> {
  return request<DiffDocument>(`/api/sessions/${encodeURIComponent(sessionId)}/diff`, signal)
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
    signal,
  )
}

async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  })
  if (response.ok) return (await response.json()) as T

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
  )
}
