import type { ChatEventPayload, ChatSnapshot } from '@legible/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchChat, interruptChat, retryChat, sendChatMessage, startReview } from '../api.js'
import { useDaemonEvents } from '../events-context.js'

export function useChat(sessionId: string) {
  const events = useDaemonEvents()
  const [snapshot, setSnapshot] = useState<ChatSnapshot>()
  const snapshotRef = useRef<ChatSnapshot | undefined>(undefined)
  const [loadError, setLoadError] = useState<string>()

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const loaded = await fetchChat(sessionId, signal)
        const current = snapshotRef.current
        if (
          !current ||
          current.sessionId !== loaded.sessionId ||
          current.revision <= loaded.revision
        ) {
          snapshotRef.current = loaded
          setSnapshot(loaded)
        }
        setLoadError(undefined)
      } catch (error) {
        if (!signal?.aborted) setLoadError(errorMessage(error))
      }
    },
    [sessionId],
  )

  useEffect(() => {
    const controller = new AbortController()
    void fetchChat(sessionId, controller.signal).then(
      (loaded) => {
        const current = snapshotRef.current
        if (
          !current ||
          current.sessionId !== loaded.sessionId ||
          current.revision <= loaded.revision
        ) {
          snapshotRef.current = loaded
          setSnapshot(loaded)
        }
        setLoadError(undefined)
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(error))
      },
    )
    return () => controller.abort()
  }, [events.connectionGeneration, sessionId])

  useEffect(
    () =>
      events.subscribe((envelope) => {
        if (envelope.type !== 'chat.event' || envelope.payload.sessionId !== sessionId) return
        const current = snapshotRef.current
        if (!current || envelope.payload.revision !== current.revision + 1) {
          if (!current || envelope.payload.revision > current.revision) void refresh()
          return
        }
        const next = applyChatEvent(current, envelope.payload)
        snapshotRef.current = next
        setSnapshot(next)
      }),
    [events, refresh, sessionId],
  )

  const command = useCallback(
    async (run: () => Promise<unknown>) => {
      await run()
      await refresh()
    },
    [refresh],
  )

  return {
    snapshot: snapshot?.sessionId === sessionId ? snapshot : undefined,
    loadError,
    refresh,
    start: () => command(() => startReview(sessionId)),
    send: (message: string) => command(() => sendChatMessage(sessionId, message)),
    interrupt: () => command(() => interruptChat(sessionId)),
    retry: () => command(() => retryChat(sessionId)),
  }
}

export function applyChatEvent(current: ChatSnapshot, payload: ChatEventPayload): ChatSnapshot {
  const next = structuredClone(current)
  next.revision = payload.revision
  const event = payload.event
  switch (event.type) {
    case 'status':
      next.status = event.status
      if (event.currentTurnId === undefined) delete next.currentTurnId
      else next.currentTurnId = event.currentTurnId
      break
    case 'entry.added':
      next.entries.push(event.entry)
      break
    case 'assistant.delta': {
      const entry = next.entries.find((candidate) => candidate.id === event.entryId)
      if (entry?.kind === 'message' && entry.role === 'assistant') entry.text += event.text
      break
    }
    case 'tool.completed': {
      const entry = next.entries.find((candidate) => candidate.id === event.entryId)
      if (entry?.kind === 'tool') {
        entry.status = 'completed'
        entry.output = event.output
      }
      break
    }
    case 'usage':
      next.lastUsage = event.usage
      break
  }
  return next
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load chat'
}
