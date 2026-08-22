// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { ChatSnapshot } from '@legible/protocol'

import { App } from '../app.js'
import { diffDocument } from '../testing/fixtures.js'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0)
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle)
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ReviewPage', () => {
  it('renders a diff, selects an anchor, and loads the whole file', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/chat')) return jsonResponse(emptyChat())
      if (url.includes('/file?')) {
        return jsonResponse({
          path: 'src/a.ts',
          side: 'RIGHT',
          sha: 'b'.repeat(40),
          content: 'one\nafter\nwhole context\n',
          isBinary: false,
          byteLength: 24,
        })
      }
      return jsonResponse(diffDocument())
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    renderReview()

    expect(await screen.findByRole('heading', { name: 'session-1' })).toBeTruthy()
    expect(document.body.textContent).toContain('src/a.ts')
    await user.click(await screen.findByRole('button', { name: 'Select RIGHT line 2' }))
    expect(document.querySelector('.anchor-status')?.textContent).toContain('RIGHT')
    expect(document.querySelector('.anchor-status')?.textContent).toContain('line 2')

    await user.click(screen.getByRole('button', { name: 'Whole file' }))
    await waitFor(() => expect(document.body.textContent).toContain('whole context'))
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('side=RIGHT'))).toBe(true)
  })

  it('shows a stable API error and retries', async () => {
    let diffAttempt = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/chat')) return jsonResponse(emptyChat())
      diffAttempt += 1
      if (diffAttempt === 1) {
        return jsonResponse(
          { error: { code: 'session_not_found', message: 'Review session not found' } },
          404,
        )
      }
      return jsonResponse(diffDocument())
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    renderReview()
    expect(await screen.findByRole('heading', { name: 'Unable to load review' })).toBeTruthy()
    expect(document.body.textContent).toContain('Review session not found')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'session-1' })).toBeTruthy()
  })

  it('renders loading and empty states', async () => {
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        if (String(input).endsWith('/chat')) return Promise.resolve(jsonResponse(emptyChat()))
        return new Promise<Response>((resolve) => {
          resolveResponse = resolve
        })
      }),
    )

    renderReview()
    expect(screen.getByRole('heading', { name: 'Loading review…' })).toBeTruthy()

    resolveResponse(jsonResponse({ ...diffDocument(), files: [], additions: 0, deletions: 0 }))
    expect(await screen.findByRole('heading', { name: 'No changes' })).toBeTruthy()
  })

  it('starts the review explicitly and collapses tool activity with the chat panel', async () => {
    let chat = emptyChat()
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/diff')) return jsonResponse(diffDocument())
      if (url.endsWith('/chat/start') && init?.method === 'POST') {
        chat = {
          ...chat,
          revision: 4,
          entries: [
            {
              id: 'user-1',
              turnId: 'turn-1',
              createdAt: '2026-08-22T00:00:00.000Z',
              kind: 'message',
              role: 'user',
              text: 'Review this pull request.',
            },
            {
              id: 'tool-1',
              turnId: 'turn-1',
              createdAt: '2026-08-22T00:00:01.000Z',
              kind: 'tool',
              name: 'shell',
              status: 'completed',
              input: 'git show',
              output: 'ok',
            },
            {
              id: 'assistant-1',
              turnId: 'turn-1',
              createdAt: '2026-08-22T00:00:02.000Z',
              kind: 'message',
              role: 'assistant',
              text: 'One finding.',
            },
          ],
        }
        return jsonResponse({ sessionId: 'session-1', turnId: 'turn-1', revision: 2 }, 202)
      }
      if (url.endsWith('/chat')) return jsonResponse(chat)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    renderReview()
    const start = await screen.findByRole('button', { name: 'Start review' })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    await user.click(start)
    expect(await screen.findByText('One finding.')).toBeTruthy()
    expect(screen.getByText('shell').closest('details')?.open).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Collapse chat' }))
    expect(screen.getByRole('button', { name: 'Open chat' })).toBeTruthy()
  })
})

function renderReview() {
  return render(
    <MemoryRouter initialEntries={['/review/session-1']}>
      <App />
    </MemoryRouter>,
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptyChat(): ChatSnapshot {
  return {
    sessionId: 'session-1',
    revision: 0,
    status: 'idle' as const,
    backend: 'codex' as const,
    entries: [],
  }
}
