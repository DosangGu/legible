import type { DaemonEventEnvelope } from '@legible/protocol'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { DaemonEventsContext, type DaemonEvents, type EventListener } from './events-context.js'
import { ApiClientError, request } from './api.js'

export function DaemonEventsProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<EventListener>())
  const [connectionGeneration, setConnectionGeneration] = useState(0)

  useEffect(() => {
    let disposed = false
    let reconnectTimer: number | undefined
    let reconnectDelay = 250
    let socket: WebSocket | undefined

    const connect = () => {
      if (disposed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${window.location.host}/api/events`)
      socket.addEventListener('open', () => {
        reconnectDelay = 250
        setConnectionGeneration((value) => value + 1)
      })
      socket.addEventListener('message', (message) => {
        try {
          const event = JSON.parse(String(message.data)) as DaemonEventEnvelope
          for (const listener of [...listeners.current]) listener(event)
        } catch {
          // A malformed daemon event is ignored; the next snapshot repairs local state.
        }
      })
      socket.addEventListener('close', () => {
        if (disposed) return
        void request('/api/auth')
          .catch((error: unknown) => {
            if (error instanceof ApiClientError && error.code === 'browser_auth_required')
              disposed = true
          })
          .finally(() => {
            if (disposed) return
            reconnectTimer = window.setTimeout(connect, reconnectDelay)
            reconnectDelay = Math.min(reconnectDelay * 2, 5_000)
          })
      })
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [])

  const value: DaemonEvents = {
    connectionGeneration,
    subscribe(listener) {
      listeners.current.add(listener)
      return () => listeners.current.delete(listener)
    },
  }

  return <DaemonEventsContext.Provider value={value}>{children}</DaemonEventsContext.Provider>
}
