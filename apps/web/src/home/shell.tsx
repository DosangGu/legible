import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export function HomeShell({ children, breadcrumb }: { children: ReactNode; breadcrumb?: string }) {
  return (
    <main className="home-shell">
      <header className="home-header">
        <Link className="home-brand" to="/">
          <span className="brand-mark brand-mark-small">L</span>Legible
        </Link>
        {breadcrumb && <span className="home-breadcrumb">/ {breadcrumb}</span>}
        <span className="local-badge">Local review workspace</span>
      </header>
      <div className="home-content">{children}</div>
    </main>
  )
}

export function LoadError({ message, retry }: { message: string; retry(): void }) {
  return (
    <div className="home-error" role="alert">
      <p>{message}</p>
      <button type="button" onClick={retry}>
        Retry
      </button>
    </div>
  )
}
