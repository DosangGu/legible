import type { CreateDraftCommentRequest, DraftComment } from '@legible/protocol'
import { useCallback, useEffect, useState } from 'react'

import { createComment, deleteComment, fetchComments, updateComment } from '../api.js'
import { useDaemonEvents } from '../events-context.js'

export function useComments(sessionId: string) {
  const events = useDaemonEvents()
  const [comments, setComments] = useState<DraftComment[]>([])
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    try {
      const loaded = await fetchComments(sessionId)
      if (!Array.isArray(loaded)) throw new Error('Invalid comment response')
      setComments(loaded)
      setError(undefined)
    } catch (value) {
      setError(errorMessage(value))
    }
  }, [sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void fetchComments(sessionId, controller.signal).then(
      (loaded) => {
        if (Array.isArray(loaded)) {
          setComments(loaded)
          setError(undefined)
        }
      },
      (value: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(value))
      },
    )
    return () => controller.abort()
  }, [events.connectionGeneration, sessionId])

  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type !== 'session.updated' || event.payload.id !== sessionId) return
        setComments(event.payload.comments)
      }),
    [events, sessionId],
  )

  return {
    comments,
    error,
    create: async (request: CreateDraftCommentRequest) => {
      const created = await createComment(sessionId, request)
      await refresh()
      return created
    },
    update: async (id: string, body: string) => {
      const updated = await updateComment(sessionId, id, body)
      await refresh()
      return updated
    },
    remove: async (id: string) => {
      await deleteComment(sessionId, id)
      await refresh()
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load comments'
}
