import { lazy, Suspense, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Repo } from '@legible/protocol'
import {
  fetchPreflight,
  fetchRepos,
  fetchSessions,
  refreshPreflight,
  registerRepo,
  touchSession,
  archiveSession,
  deleteArchivedSession,
} from '../api.js'
import { HomeShell, LoadError } from './shell.js'
import { useResource } from './use-resource.js'

const CheckoutManager = lazy(async () => ({
  default: (await import('./checkout-manager.js')).CheckoutManager,
}))
const DirectoryPicker = lazy(async () => ({
  default: (await import('./directory-picker.js')).DirectoryPicker,
}))

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
  const [repoFilter, setRepoFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('active')
  const [managedRepo, setManagedRepo] = useState<Repo>()
  const [browsing, setBrowsing] = useState(false)
  const [deleting, setDeleting] = useState<string>()
  const visibleSessions = (state.data?.sessions ?? [])
    .filter((session) => {
      if (repoFilter !== 'all' && session.repoId !== repoFilter) return false
      if (statusFilter === 'all') return true
      if (statusFilter === 'archived') return Boolean(session.archivedAt)
      if (statusFilter === 'active' && session.deletionRequestedAt) return true
      if (session.archivedAt) return false
      if (statusFilter === 'draft') return !session.submission
      if (statusFilter === 'submitted') return session.submission?.status === 'submitted'
      if (statusFilter === 'attention')
        return session.submission && session.submission.status !== 'submitted'
      return true
    })
    .sort((a, b) => (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt))
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
  const openRepository = (selectedPath: string) => {
    setPath(selectedPath)
    void act(async () => {
      const repo = await registerRepo(selectedPath)
      navigate(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`)
    })
  }
  const register = (event: FormEvent) => {
    event.preventDefault()
    openRepository(path.trim())
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
      {managedRepo && (
        <Suspense fallback={<p role="status">Loading checkout management…</p>}>
          <CheckoutManager
            key={managedRepo.id}
            repo={managedRepo}
            onClose={() => setManagedRepo(undefined)}
            onRemoved={state.reload}
          />
        </Suspense>
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
              <button
                type="button"
                className="browse-button"
                disabled={busy}
                onClick={() => setBrowsing((value) => !value)}
              >
                {browsing ? 'Hide browser' : 'Browse folders'}
              </button>
              {browsing && (
                <Suspense fallback={<p role="status">Loading directory browser…</p>}>
                  <DirectoryPicker
                    busy={busy}
                    onClose={() => setBrowsing(false)}
                    onSelect={openRepository}
                  />
                </Suspense>
              )}
            </section>
            <section className="home-card">
              <div className="section-heading">
                <h2>Recent reviews</h2>
                <span className="count-badge">{visibleSessions.length}</span>
              </div>
              <div className="review-filters">
                <div>
                  <label htmlFor="filter-repository">Repository</label>
                  <select
                    id="filter-repository"
                    value={repoFilter}
                    onChange={(event) => setRepoFilter(event.target.value)}
                  >
                    <option value="all">All repositories</option>
                    {[
                      ...new Set([
                        ...state.data.repos.map((repo) => repo.id),
                        ...state.data.sessions.map((session) => session.repoId),
                      ]),
                    ]
                      .sort()
                      .map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="filter-review-status">Review status</label>
                  <select
                    id="filter-review-status"
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    <option value="active">Not archived</option>
                    <option value="draft">Draft</option>
                    <option value="submitted">Submitted</option>
                    <option value="attention">Submission pending / uncertain</option>
                    <option value="archived">Archived</option>
                    <option value="all">All reviews</option>
                  </select>
                </div>
              </div>
              {visibleSessions.length === 0 ? (
                <div className="home-empty">
                  <h3>
                    {state.data.sessions.length === 0 ? 'No reviews yet' : 'No matching reviews'}
                  </h3>
                  <p>
                    {state.data.sessions.length === 0
                      ? 'Open a repository and choose a pull request to begin.'
                      : 'Change the filters to find saved or archived reviews.'}
                  </p>
                </div>
              ) : (
                <ul className="review-list">
                  {visibleSessions.map((session) => (
                    <li key={session.id} className="managed-review-row">
                      <button
                        className="review-row"
                        type="button"
                        disabled={busy || Boolean(session.deletionRequestedAt)}
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
                          {session.deletionRequestedAt
                            ? 'Deletion pending · retry'
                            : session.archivedAt
                              ? 'Archived · open to restore'
                              : (session.submission?.status ?? 'Draft')}
                        </span>
                      </button>
                      {!session.deletionRequestedAt && (
                        <button
                          type="button"
                          className="review-archive-button"
                          disabled={
                            busy ||
                            Boolean(
                              !session.archivedAt &&
                              session.submission &&
                              (session.submission.status !== 'submitted' ||
                                session.submission.cleanup.status !== 'complete'),
                            )
                          }
                          aria-label={`${session.archivedAt ? 'Restore' : 'Archive'} ${session.pullRequest?.title ?? `review #${String(session.prNumber)}`}`}
                          onClick={() =>
                            void act(async () => {
                              await archiveSession(session, !session.archivedAt)
                              state.reload()
                            })
                          }
                        >
                          {session.archivedAt ? 'Restore' : 'Archive'}
                        </button>
                      )}
                      {session.archivedAt &&
                        (deleting === session.id ? (
                          <div
                            className="checkout-confirm"
                            role="group"
                            aria-label="Confirm review deletion"
                          >
                            <p>
                              Permanently delete this local review, chat and clean managed worktree?
                              This cannot be undone. GitHub reviews and the repository checkout stay
                              untouched.
                            </p>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void act(async () => {
                                  await deleteArchivedSession(session)
                                  setDeleting(undefined)
                                  state.reload()
                                })
                              }
                            >
                              Confirm delete
                            </button>{' '}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setDeleting(undefined)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="review-archive-button"
                            disabled={busy}
                            onClick={() => setDeleting(session.id)}
                          >
                            {session.deletionRequestedAt ? 'Retry delete' : 'Delete'}
                          </button>
                        ))}
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
                      <button type="button" onClick={() => setManagedRepo(repo)}>
                        Manage checkouts
                      </button>
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
