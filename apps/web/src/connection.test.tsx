// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectBrowser } from './browser-auth.js'
import { BrowserConnection } from './connection.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('Browser connection', () => {
  it('removes the bootstrap secret before sending it and never stores it', async () => {
    window.history.replaceState(null, '', '/review/session#token=temporary-secret')
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(window.location.hash).toBe('')
      expect(window.location.pathname).toBe('/review/session')
      expect(options.body).toBe(JSON.stringify({ token: 'temporary-secret' }))
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetch)
    await connectBrowser()
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('gates children, handles expiry and reconnects with a pasted token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    )
    render(
      <BrowserConnection initial={Promise.resolve()}>
        <h1>Private workspace</h1>
      </BrowserConnection>,
    )
    expect(await screen.findByRole('heading', { name: 'Private workspace' })).toBeTruthy()
    act(() => window.dispatchEvent(new Event('legible:auth-required')))
    expect(screen.queryByRole('heading', { name: 'Private workspace' })).toBeNull()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Or paste its connection token'), 'replacement-token')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('heading', { name: 'Private workspace' })).toBeTruthy()
  })
})
