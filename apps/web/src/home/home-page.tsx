import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  fetchPreflight,
  fetchRepos,
  fetchSessions,
  refreshPreflight,
  registerRepo,
  touchSession,
} from '../api.js'
import { HomeShell, LoadError } from './shell.js'
import { useResource } from './use-resource.js'

const loadHome = async (signal: AbortSignal) => {
  const [repos, sessions, preflight] = await Promise.all([
    fetchRepos(signal),
    fetchSessions(signal),
    fetchPreflight(signal),
  ])
  return { repos, sessions, preflight }
}

export function HomePage() {
  const state = useResource('home', loadHome)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const navigate = useNavigate()
  const act = async (operation: () => Promise<void>) => {
    setBusy(true)
    setFailure('')
    try {
      await operation()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Operation failed')
    } finally {
      setBusy(false)
    }
  }
  const register = (event: FormEvent) => {
    event.preventDefault()
    void act(async () => {
      const repo = await registerRepo(path.trim())
      navigate(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`)
    })
  }
  return (
    <HomeShell>
      <div className="section-heading">
        <div>
          <p className="home-kicker">YOUR WORKSPACE</p>
          <h1>Pull request reviews</h1>
        </div>
      </div>
      {failure && (
        <p className="home-error" role="alert">
          {failure}
        </p>
      )}
      {state.error ? (
        <LoadError message={state.error} retry={state.reload} />
      ) : !state.data ? (
        <p role="status">Loading workspace…</p>
      ) : (
        <div className="home-grid">
          <section className="home-primary">
            <section className="home-card">
              <h2>Open repository</h2>
              <p>Paste a local Git checkout path. Your files stay on this machine.</p>
              <form className="path-form" onSubmit={register}>
                <label className="sr-only" htmlFor="repo-path">
                  Repository path
                </label>
                <input
                  id="repo-path"
                  placeholder="/home/you/source/owner/repo"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  required
                  autoComplete="off"
                />
                <button className="primary-button" disabled={busy} type="submit">
                  {busy ? 'Working…' : 'Open repository'}
                </button>
              </form>
            </section>
            <section className="home-card">
              <div className="section-heading">
                <h2>Recent reviews</h2>
                <span className="count-badge">{state.data.sessions.length}</span>
              </div>
              {state.data.sessions.length === 0 ? (
                <div className="home-empty">
                  <h3>No reviews yet</h3>
                  <p>Open a repository and choose a pull request to begin.</p>
                </div>
              ) : (
                <ul className="review-list">
                  {[...state.data.sessions]
                    .sort((a, b) =>
                      (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt),
                    )
                    .map((session) => (
                      <li key={session.id}>
                        <button
                          className="review-row"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await touchSession(session.id)
                              navigate(`/review/${encodeURIComponent(session.id)}`)
                            })
                          }
                        >
                          <span>
                            <span className="row-title">
                              {session.pullRequest?.title ??
                                `Pull request #${String(session.prNumber)}`}
                            </span>
                            <span className="row-meta">
                              {session.repoId} · #{session.prNumber} · {session.config.main.backend}
                            </span>
                          </span>
                          <span className="status-badge">
                            {session.submission?.status ?? 'Draft'}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </section>
          </section>
          <aside className="home-sidebar">
            <section className="home-card">
              <h2>Repositories</h2>
              {state.data.repos.length === 0 ? (
                <p>No repositories registered.</p>
              ) : (
                <ul className="repo-list">
                  {state.data.repos.map((repo) => (
                    <li key={repo.id}>
                      <Link
                        to={`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`}
                      >
                        <strong>{repo.id}</strong>
                        <span className="row-meta">{repo.primaryCheckout}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="home-card">
              <div className="section-heading">
                <h2>Setup</h2>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await refreshPreflight()
                      state.reload()
                    })
                  }
                >
                  Refresh
                </button>
              </div>
              <ul className="setup-list">
                {state.data.preflight.checks.map((check) => (
                  <li key={check.tool}>
                    <div>
                      <strong>{check.tool}</strong>
                      <span
                        className={`setup-status ${check.status === 'ready' ? 'is-ready' : ''}`}
                      >
                        {check.status}
                      </span>
                    </div>
                    {check.message && <p>{check.message}</p>}
                  </li>
                ))}
              </ul>
              <p className="home-hint">
                Only the agent you select needs to be ready. Refresh after signing in from your
                terminal.
              </p>
            </section>
          </aside>
        </div>
      )}
    </HomeShell>
  )
}
