import { useEffect, useState } from 'react'
import { useDaemonEvents } from '../events-context.js'

/** Fetch afresh after relevant broadcasts and reconnects; stale responses never replace a new route. */
export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const events = useDaemonEvents()
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: '' })
  const requestKey = `${key}:${String(revision)}:${String(events.connectionGeneration)}`
  useEffect(
    () =>
      events.subscribe((event) => {
        if (
          [
            'repo.updated',
            'session.added',
            'session.updated',
            'session.removed',
            'preflight.updated',
          ].includes(event.type)
        )
          setRevision((value) => value + 1)
      }),
    [events],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key: requestKey, data })
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key: requestKey,
            error: error instanceof Error ? error.message : 'Unable to load data',
          })
      },
    )
    return () => controller.abort()
  }, [requestKey, load])
  return {
    data: state.key === requestKey ? state.data : undefined,
    error: state.key === requestKey ? state.error : undefined,
    reload: () => setRevision((value) => value + 1),
  }
}
