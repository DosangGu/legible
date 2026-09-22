import type { CodeSearchMatch, CodeSearchResult } from '@legible/protocol'
import { useEffect, useRef, useState } from 'react'
import { searchCode } from '../api.js'

export function SearchPanel({
  sessionId,
  revision,
  headSha,
  onOpen,
}: {
  sessionId: string
  revision: number
  headSha: string
  onOpen(match: CodeSearchMatch, query: string): void
}) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<CodeSearchResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const active = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => active.current?.abort(), [])
  const search = async () => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      const loaded = await searchCode(sessionId, query, revision, controller.signal)
      if (controller.signal.aborted) return
      if (loaded.reviewRevision !== revision || loaded.headSha !== headSha)
        throw new Error('Review changed. Search again on the latest revision.')
      setResult(loaded)
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'Search failed')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return (
    <section className="repo-search" aria-label="Repository code search">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void search()
        }}
      >
        <label htmlFor="repo-query">Search pinned HEAD</label>
        <input
          id="repo-query"
          type="search"
          maxLength={256}
          value={query}
          placeholder="Case-sensitive literal text"
          onChange={(event) => {
            active.current?.abort()
            setBusy(false)
            setResult(undefined)
            setError(undefined)
            setQuery(event.target.value)
          }}
        />
        <div className="search-actions">
          <button disabled={!query.trim() || busy} type="submit">
            {busy ? 'Searching…' : 'Search code'}
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => {
                active.current?.abort()
                setBusy(false)
              }}
            >
              Cancel search
            </button>
          )}
        </div>
      </form>
      {error && <p role="alert">{error} Submit the query to retry.</p>}
      {result && (
        <>
          <p role="status">
            {result.matches.length
              ? `${String(result.matches.length)} matching lines`
              : 'No matches'}
            {result.truncated ? ' · Results limited; narrow your query.' : ''}
          </p>
          {result.skippedLargeFiles > 0 && (
            <p>{result.skippedLargeFiles} files over 1 MiB skipped.</p>
          )}
          <ul className="search-results">
            {result.matches.map((match) => (
              <li key={`${match.path}:${String(match.line)}`}>
                <button
                  type="button"
                  onClick={() => onOpen(match, result.query)}
                  title={`${match.path}:${String(match.line)}`}
                >
                  <strong>
                    {match.path}:{match.line}
                  </strong>
                  <code>{match.preview}</code>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
