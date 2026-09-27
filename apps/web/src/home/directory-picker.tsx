import { useEffect, useRef, useState } from 'react'
import type { DirectoryListing } from '@legible/protocol'
import { fetchDirectories } from '../api.js'

type DirectoryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; listing: DirectoryListing }

export function DirectoryPicker({
  busy,
  onClose,
  onSelect,
}: {
  busy: boolean
  onClose(): void
  onSelect(path: string): void
}) {
  const [path, setPath] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<DirectoryState>({ status: 'loading' })
  const active = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    active.current = controller
    void fetchDirectories(path, controller.signal).then(
      (listing) => {
        if (!controller.signal.aborted) setState({ status: 'ready', listing })
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to browse directories',
          })
      },
    )
    return () => {
      controller.abort()
      if (active.current === controller) active.current = undefined
    }
  }, [path, retry])

  const navigate = (next: string) => {
    active.current?.abort()
    setState({ status: 'loading' })
    setPath(next)
  }

  return (
    <section className="directory-picker" aria-label="Choose repository directory">
      <div className="section-heading">
        <h3>Choose a repository</h3>
        <button type="button" onClick={onClose} disabled={busy}>
          Close browser
        </button>
      </div>
      {state.status === 'loading' ? (
        <p role="status">Loading directories…</p>
      ) : state.status === 'error' ? (
        <div role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry browsing
          </button>
        </div>
      ) : (
        <>
          <p className="directory-location" title={state.listing.path}>
            {state.listing.path}
          </p>
          <div className="directory-actions">
            <button
              type="button"
              disabled={!state.listing.parent || busy}
              onClick={() => {
                if (state.listing.parent) navigate(state.listing.parent)
              }}
            >
              Up one folder
            </button>
            <button type="button" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
              Refresh folders
            </button>
          </div>
          {state.listing.repository ? (
            <div className="directory-found">
              <span className="status-badge">Git checkout</span>
              <button type="button" disabled={busy} onClick={() => onSelect(state.listing.path)}>
                {busy ? 'Opening…' : 'Open this repository'}
              </button>
            </div>
          ) : state.listing.entries.length === 0 ? (
            <p>No visible folders here. Paste a checkout path above if you know it.</p>
          ) : (
            <ul className="directory-list">
              {state.listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => (entry.repository ? onSelect(entry.path) : navigate(entry.path))}
                    aria-label={`${entry.repository ? 'Open repository' : 'Open folder'} ${entry.name}`}
                  >
                    <span className="directory-name">{entry.name}</span>
                    <span className="row-meta">{entry.repository ? 'Git checkout' : 'Folder'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.listing.truncated && (
            <p className="home-hint" role="status">
              Directory listing is limited. Paste a checkout path above if it is not shown.
            </p>
          )}
        </>
      )}
    </section>
  )
}
