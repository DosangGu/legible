import { useCallback, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AgentBackendKind, type AgentSpec } from '@legible/protocol'
import { fetchPullRequests, openReview } from '../api.js'
import { HomeShell, LoadError } from './shell.js'
import { useResource } from './use-resource.js'

export function RepoPage() {
  const { owner = '', name = '' } = useParams()
  const [search] = useSearchParams()
  const requested = search.get('pr') ?? ''
  const pr =
    /^[1-9]\d*$/u.test(requested) && Number.isSafeInteger(Number(requested)) ? requested : ''
  return <Repository key={`${owner}/${name}/${pr}`} owner={owner} name={name} initialNumber={pr} />
}

function Repository({
  owner,
  name,
  initialNumber,
}: {
  owner: string
  name: string
  initialNumber: string
}) {
  const [page, setPage] = useState(1)
  const load = useCallback(
    (signal: AbortSignal) => fetchPullRequests(owner, name, page, signal),
    [owner, name, page],
  )
  const state = useResource(`${owner}/${name}/${String(page)}`, load)
  const [spec, setSpec] = useState<AgentSpec>({
    backend: AgentBackendKind.Claude,
    shell: 'none',
    network: 'off',
    onOutOfScope: 'deny',
  })
  const [number, setNumber] = useState(initialNumber)
  const [opening, setOpening] = useState<number>()
  const [failure, setFailure] = useState('')
  const navigate = useNavigate()
  const open = async (prNumber: number) => {
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
      setFailure('Enter a positive PR number')
      return
    }
    setOpening(prNumber)
    setFailure('')
    try {
      const main = { ...spec }
      if (!main.model) delete main.model
      if (!main.effort) delete main.effort
      const result = await openReview({ repoId: `${owner}/${name}`, prNumber, config: { main } })
      navigate(`/review/${encodeURIComponent(result.session.id)}`)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Unable to open review')
    } finally {
      setOpening(undefined)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void open(Number(number))
  }
  return (
    <HomeShell breadcrumb={`${owner}/${name}`}>
      <Link className="back-link" to="/">
        ← Workspace
      </Link>
      <div className="section-heading">
        <div>
          <p className="home-kicker">PULL REQUESTS</p>
          <h1>
            {owner}/{name}
          </h1>
        </div>
        <button type="button" onClick={state.reload} disabled={opening !== undefined}>
          Refresh list
        </button>
      </div>
      <div className="home-grid">
        <section className="home-primary">
          {failure && (
            <p className="home-error" role="alert">
              {failure}
            </p>
          )}
          {opening !== undefined && (
            <p role="status">
              Preparing #{opening}… Fetching the pinned diff. No agent is running yet.
            </p>
          )}
          <section className="home-card">
            <div className="section-heading">
              <h2>Open pull requests</h2>
              <span className="row-meta">Updated recently</span>
            </div>
            {state.error ? (
              <LoadError message={state.error} retry={state.reload} />
            ) : !state.data ? (
              <p role="status">Loading pull requests…</p>
            ) : (
              <>
                {state.data.items.length === 0 ? (
                  <div className="home-empty">
                    <h3>No open pull requests</h3>
                    <p>You can still open a review by PR number.</p>
                  </div>
                ) : (
                  <ul className="review-list">
                    {state.data.items.map((pull) => (
                      <li key={pull.number}>
                        <button
                          className="review-row"
                          type="button"
                          disabled={opening !== undefined}
                          onClick={() => void open(pull.number)}
                        >
                          <span>
                            <span className="row-title">{pull.title}</span>
                            <span className="row-meta">
                              #{pull.number} · {pull.author} · {pull.headRef} → {pull.baseRef}
                            </span>
                          </span>
                          <span className="status-badge">
                            {pull.draft ? 'Draft PR' : 'Open review'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <nav className="pagination" aria-label="Pull request pages">
                  <button
                    type="button"
                    disabled={page === 1 || opening !== undefined}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous
                  </button>
                  <span>Page {page}</span>
                  <button
                    type="button"
                    disabled={!state.data.hasNextPage || opening !== undefined}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </button>
                </nav>
              </>
            )}
          </section>
        </section>
        <aside className="home-sidebar">
          <section className="home-card agent-settings">
            <h2>Review agent</h2>
            <label htmlFor="review-backend">Backend</label>
            <select
              id="review-backend"
              value={spec.backend}
              disabled={opening !== undefined}
              onChange={(event) => {
                const backend = event.target.value as AgentBackendKind
                setSpec({
                  backend,
                  shell: backend === AgentBackendKind.Claude ? 'none' : 'broad',
                  network: 'off',
                  onOutOfScope: 'deny',
                })
              }}
            >
              <option value={AgentBackendKind.Claude}>Claude</option>
              <option value={AgentBackendKind.Codex}>Codex</option>
            </select>
            <details>
              <summary>Advanced settings</summary>
              <fieldset disabled={opening !== undefined}>
                <label htmlFor="review-model">Model</label>
                <input
                  id="review-model"
                  placeholder="CLI default"
                  value={spec.model ?? ''}
                  onChange={(event) => setSpec({ ...spec, model: event.target.value })}
                  maxLength={256}
                />
                <label htmlFor="review-effort">Effort</label>
                <input
                  id="review-effort"
                  placeholder="CLI default"
                  value={spec.effort ?? ''}
                  onChange={(event) => setSpec({ ...spec, effort: event.target.value })}
                  maxLength={256}
                />
                <label htmlFor="review-shell">Shell access</label>
                <select
                  id="review-shell"
                  value={spec.shell}
                  onChange={(event) =>
                    setSpec({ ...spec, shell: event.target.value as AgentSpec['shell'] })
                  }
                >
                  <option value="none">None</option>
                  {spec.backend === AgentBackendKind.Codex && (
                    <option value="broad">Commands in read-only sandbox</option>
                  )}
                </select>
                <label htmlFor="review-network">Network tools</label>
                <select
                  id="review-network"
                  value={spec.network}
                  onChange={(event) =>
                    setSpec({ ...spec, network: event.target.value as AgentSpec['network'] })
                  }
                >
                  <option value="off">Off</option>
                  <option value="fetch">Web research</option>
                  {spec.backend === AgentBackendKind.Codex && (
                    <option value="free">Commands + web research</option>
                  )}
                </select>
              </fieldset>
            </details>
            <p className="home-hint">
              Files remain read-only. Opening a PR does not call the agent. Use Start review when
              you are ready.
            </p>
            <p className="home-hint">
              Existing reviews retain their pinned commits, agent settings, and conversation.
            </p>
          </section>
          <section className="home-card">
            <h2>Open by number</h2>
            <form onSubmit={submit} className="number-form">
              <label htmlFor="pull-number">Pull request number</label>
              <input
                id="pull-number"
                type="number"
                min="1"
                step="1"
                value={number}
                onChange={(event) => setNumber(event.target.value)}
                required
              />
              <button className="primary-button" type="submit" disabled={opening !== undefined}>
                Open review
              </button>
            </form>
          </section>
        </aside>
      </div>
    </HomeShell>
  )
}
