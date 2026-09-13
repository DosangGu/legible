import { request } from './api.js'

export function authenticateBrowser(token: string): Promise<void> {
  return request('/api/auth', { method: 'POST', body: JSON.stringify({ token }) })
}

/** Run once before mounting React; never retain the secret in URL/history/storage. */
export function connectBrowser(): Promise<unknown> {
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const token = fragment.get('token')
  if (token !== null) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    return authenticateBrowser(token)
  }
  return request('/api/auth')
}
