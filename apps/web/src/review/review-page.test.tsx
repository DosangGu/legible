// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { ChatSnapshot, ReviewSession } from '@legible/protocol'

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
      if (url === '/api/sessions/session-1') return jsonResponse(webSession())
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
      const url = String(input)
      if (url === '/api/sessions/session-1') return jsonResponse(webSession())
      if (url.endsWith('/chat')) return jsonResponse(emptyChat())
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
        const url = String(input)
        if (url === '/api/sessions/session-1') return Promise.resolve(jsonResponse(webSession()))
        if (url.endsWith('/chat')) return Promise.resolve(jsonResponse(emptyChat()))
        return new Promise<Response>((resolve) => {
          resolveResponse = resolve
        })
      }),
    )

    renderReview()
    expect(screen.getByRole('heading', { name: 'Loading review…' })).toBeTruthy()

    await waitFor(() => expect(resolveResponse).toBeTypeOf('function'))
    resolveResponse(jsonResponse({ ...diffDocument(), files: [], additions: 0, deletions: 0 }))
    expect(await screen.findByRole('heading', { name: 'No changes' })).toBeTruthy()
  })

  it('starts the review explicitly and collapses tool activity with the chat panel', async () => {
    let chat = emptyChat()
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/sessions/session-1') return jsonResponse(webSession())
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

  it('creates an inline multi-line draft with click then shift-click', async () => {
    let comments: unknown[] = []
    let submitted: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/sessions/session-1') return jsonResponse(webSession())
        if (url.endsWith('/diff')) return jsonResponse(diffDocument())
        if (url.endsWith('/chat')) return jsonResponse(emptyChat())
        if (url.endsWith('/comments') && init?.method === 'POST') {
          submitted = JSON.parse(String(init.body)) as Record<string, unknown>
          const created = {
            id: 'comment-1',
            ...submitted,
            origin: 'human',
            createdAt: '2026-08-22T00:00:00.000Z',
          }
          comments = [created]
          return jsonResponse(created, 201)
        }
        if (url.endsWith('/comments')) return jsonResponse(comments)
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    const user = userEvent.setup()
    renderReview()

    await user.click(await screen.findByRole('button', { name: 'Select RIGHT line 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select RIGHT line 3' }), {
      shiftKey: true,
    })
    await user.type(await screen.findByRole('textbox', { name: 'Comment body' }), 'Range draft')
    await user.click(screen.getByRole('button', { name: 'Save comment' }))

    await waitFor(() => expect(document.body.textContent).toContain('Range draft'))
    expect(submitted).toMatchObject({
      path: 'src/a.ts',
      side: 'RIGHT',
      startLine: 2,
      startSide: 'RIGHT',
      line: 3,
    })
  })

  it('warns about a stale head, submits on confirmation, and shows the receipt', async () => {
    const submissions: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/sessions/session-1') return jsonResponse(webSession())
        if (url.endsWith('/diff')) return jsonResponse(diffDocument())
        if (url.endsWith('/chat')) return jsonResponse(emptyChat())
        if (url.endsWith('/comments')) return jsonResponse([])
        if (url.endsWith('/submission') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          submissions.push(body)
          if (!body.allowStaleHead) {
            return jsonResponse(
              {
                error: {
                  code: 'stale_pr_head',
                  message: 'The pull request HEAD has changed',
                  details: {
                    pinnedHeadSha: 'b'.repeat(40),
                    currentHeadSha: 'c'.repeat(40),
                  },
                },
              },
              409,
            )
          }
          return jsonResponse(
            webSession({
              submission: {
                status: 'submitted',
                event: 'COMMENT',
                body: 'Looks good overall',
                marker: '<!-- legible-review-session:session-1 -->',
                startedAt: '2026-08-23T00:00:00.000Z',
                currentHeadSha: 'c'.repeat(40),
                staleHead: true,
                githubReviewId: 91,
                htmlUrl: 'https://github.com/owner/repo/pull/42#pullrequestreview-91',
                submittedAt: '2026-08-23T00:00:01.000Z',
                cleanup: { status: 'complete' },
              },
            }),
          )
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    const user = userEvent.setup()
    renderReview()

    await user.click(await screen.findByRole('button', { name: 'Submit review' }))
    const dialog = screen.getByRole('dialog')
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Review summary' }),
      'Looks good overall',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Submit review' }))
    expect(await within(dialog).findByText(/PR HEAD changed/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Submit pinned review anyway' }))

    expect(await screen.findByRole('heading', { name: 'Review submitted' })).toBeTruthy()
    expect(submissions).toEqual([
      { event: 'COMMENT', body: 'Looks good overall' },
      { event: 'COMMENT', body: 'Looks good overall', allowStaleHead: true },
    ])
    expect(screen.getByRole('link', { name: 'Open on GitHub' })).toBeTruthy()
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

function webSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'session-1',
    repoId: 'owner/repo',
    prNumber: 42,
    headSha: 'b'.repeat(40),
    baseSha: 'a'.repeat(40),
    worktreePath: '/state/worktrees/owner/repo/pr-42',
    config: {
      main: {
        backend: 'codex',
        shell: 'git',
        network: 'fetch',
        onOutOfScope: 'deny',
      },
    },
    comments: [],
    createdAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  }
}
