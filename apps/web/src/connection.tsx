import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { authenticateBrowser } from './browser-auth.js'

export function BrowserConnection({
  initial,
  children,
}: {
  initial: Promise<unknown>
  children: ReactNode
}) {
  const [status, setStatus] = useState<'connecting' | 'ready' | 'disconnected'>('connecting')
  const [failure, setFailure] = useState('')
  const [token, setToken] = useState('')
  useEffect(() => {
    let disposed = false
    void initial.then(
      () => {
        if (!disposed) setStatus('ready')
      },
      (error: unknown) => {
        if (!disposed) {
          setStatus('disconnected')
          setFailure(error instanceof Error ? error.message : 'Unable to connect')
        }
      },
    )
    const expired = () => {
      setStatus('disconnected')
      setFailure('Connection expired. Use the current connection URL printed by the daemon.')
    }
    window.addEventListener('legible:auth-required', expired)
    return () => {
      disposed = true
      window.removeEventListener('legible:auth-required', expired)
    }
  }, [initial])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = token.trim()
    setToken('')
    setStatus('connecting')
    setFailure('')
    try {
      await authenticateBrowser(value)
      setStatus('ready')
    } catch (error) {
      setStatus('disconnected')
      setFailure(error instanceof Error ? error.message : 'Unable to connect')
    }
  }
  if (status === 'ready') return children
  return (
    <main className="placeholder-page connection-page">
      <div className="brand-mark">L</div>
      <h1>{status === 'connecting' ? 'Connecting to Legible…' : 'Connect to Legible'}</h1>
      <p>Open the connection URL printed in your daemon terminal.</p>
      {failure && <p role="alert">{failure}</p>}
      {status === 'disconnected' && (
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="connection-token">Or paste its connection token</label>
          <input
            id="connection-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
          <button className="primary-button" type="submit">
            Connect
          </button>
        </form>
      )}
    </main>
  )
}
