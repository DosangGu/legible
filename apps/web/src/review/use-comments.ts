import type { CreateDraftCommentRequest, DraftComment } from '@legible/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  createComment,
  deleteComment,
  fetchComments,
  updateComment,
  reanchorComment,
} from '../api.js'
import { useDaemonEvents } from '../events-context.js'

export function useComments(sessionId: string, revision = 0, initialComments: DraftComment[] = []) {
  const events = useDaemonEvents()
  const [loadedComments, setLoadedComments] = useState<{ key: string; comments: DraftComment[] }>()
  const [error, setError] = useState<string>()
  const key = `${sessionId}:${String(revision)}`
  const currentKey = useRef(key)
  useEffect(() => {
    currentKey.current = key
  }, [key])

  const refresh = useCallback(async () => {
    try {
      const loaded = await fetchComments(sessionId, undefined, revision)
      if (currentKey.current !== key) return
      if (!Array.isArray(loaded)) throw new Error('Invalid comment response')
      setLoadedComments({ key, comments: loaded })
      setError(undefined)
    } catch (value) {
      if (currentKey.current === key) setError(errorMessage(value))
    }
  }, [sessionId, revision, key])

  useEffect(() => {
    const controller = new AbortController()
    void fetchComments(sessionId, controller.signal, revision).then(
      (loaded) => {
        if (controller.signal.aborted) return
        if (Array.isArray(loaded)) {
          setLoadedComments({ key, comments: loaded })
          setError(undefined)
        }
      },
      (value: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(value))
      },
    )
    return () => controller.abort()
  }, [events.connectionGeneration, sessionId, revision, key])

  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type !== 'session.updated' || event.payload.id !== sessionId) return
        if ((event.payload.reviewRevision ?? 0) !== revision) return
        setLoadedComments({ key, comments: event.payload.comments })
      }),
    [events, sessionId, revision, key],
  )

  return {
    comments: loadedComments?.key === key ? loadedComments.comments : initialComments,
    error,
    create: async (request: CreateDraftCommentRequest) => {
      const created = await createComment(sessionId, request, revision)
      await refresh()
      return created
    },
    update: async (id: string, body: string) => {
      const updated = await updateComment(sessionId, id, body, revision)
      await refresh()
      return updated
    },
    remove: async (id: string) => {
      await deleteComment(sessionId, id, revision)
      await refresh()
    },
    reanchor: async (id: string, anchor: Omit<CreateDraftCommentRequest, 'body'>) => {
      await reanchorComment(sessionId, id, anchor, revision)
      await refresh()
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load comments'
}
