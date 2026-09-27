import { useCallback, useState } from 'react'
import type { Repo } from '@legible/protocol'
import { fetchCheckouts, forgetCheckout, setPrimaryCheckout, unregisterRepo } from '../api.js'
import { LoadError } from './shell.js'
import { useResource } from './use-resource.js'

export function CheckoutManager({
  repo,
  onClose,
  onRemoved,
}: {
  repo: Repo
  onClose(): void
  onRemoved(): void
}) {
  const load = useCallback((signal: AbortSignal) => fetchCheckouts(repo, signal), [repo])
  const state = useResource(`checkouts:${repo.id}`, load)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [forgetting, setForgetting] = useState<string>()
  const [unregistering, setUnregistering] = useState(false)
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    setFailure('')
    try {
      await operation()
      setForgetting(undefined)
      state.reload()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Unable to update checkout')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="home-card checkout-manager" aria-label={`Manage ${repo.id}`}>
      <div className="section-heading">
        <h2>Checkouts · {repo.id}</h2>
        <button type="button" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
      <p className="home-hint">
        Forgetting a path only removes its registration. Files are never deleted. Register another
        clone using Open repository.
      </p>
      {failure && (
        <p className="home-error" role="alert">
          {failure}
        </p>
      )}
      {state.error ? (
        <LoadError message={state.error} retry={state.reload} />
      ) : !state.data ? (
        <p role="status">Checking paths…</p>
      ) : (
        <>
          <p>{state.data.sessionCount} saved reviews, including archived reviews.</p>
          {state.data.primaryChangeBlocked && (
            <p className="home-hint">Primary locked: {state.data.primaryChangeBlocked}</p>
          )}
          <ul className="checkout-list">
            {state.data.checkouts.map((checkout) => {
              const primary = checkout.path === state.data!.repo.primaryCheckout
              return (
                <li key={checkout.path}>
                  <div>
                    <strong className="checkout-path">{checkout.path}</strong>
                    <span className="row-meta">
                      {primary ? 'Primary · ' : ''}
                      {checkout.available ? 'Available' : 'Unavailable'}
                    </span>
                  </div>
                  {checkout.message && <p className="home-hint">{checkout.message}</p>}
                  {!primary && (
                    <div className="checkout-actions">
                      <button
                        type="button"
                        disabled={
                          busy || !checkout.available || Boolean(state.data!.primaryChangeBlocked)
                        }
                        onClick={() => void act(() => setPrimaryCheckout(repo, checkout.path))}
                      >
                        Make primary
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setForgetting(checkout.path)}
                      >
                        Forget path
                      </button>
                    </div>
                  )}
                  {forgetting === checkout.path && (
                    <div
                      className="checkout-confirm"
                      role="group"
                      aria-label="Confirm forgetting path"
                    >
                      <p>Forget this registration? The local checkout stays on disk.</p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => forgetCheckout(repo, checkout.path))}
                      >
                        Confirm forget
                      </button>{' '}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setForgetting(undefined)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <button type="button" disabled={busy} onClick={state.reload}>
            Check paths again
          </button>
          {unregistering ? (
            <div className="checkout-confirm" role="group" aria-label="Confirm repository removal">
              <p>
                Remove {repo.id} from Legible? This only deletes its registration. The checkout
                stays on disk.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await unregisterRepo(repo)
                    onRemoved()
                    onClose()
                  })
                }
              >
                Confirm remove repository
              </button>{' '}
              <button type="button" disabled={busy} onClick={() => setUnregistering(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy || Boolean(state.data.primaryChangeBlocked)}
              onClick={() => setUnregistering(true)}
            >
              Remove repository registration
            </button>
          )}
        </>
      )}
    </section>
  )
}
