import type { DaemonEventEnvelope } from '@legible/protocol'
import { createContext, useContext } from 'react'

export type EventListener = (event: DaemonEventEnvelope) => void

export type DaemonEvents = {
  connectionGeneration: number
  subscribe(listener: EventListener): () => void
}

export const DaemonEventsContext = createContext<DaemonEvents>({
  connectionGeneration: 0,
  subscribe: () => () => undefined,
})

export function useDaemonEvents(): DaemonEvents {
  return useContext(DaemonEventsContext)
}
