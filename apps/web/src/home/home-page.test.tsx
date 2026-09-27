// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AgentBackendKind } from '@legible/protocol'
import { HomePage } from './home-page.js'
import { RepoPage } from './repo-page.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const repo = {
  id: 'owner/repo',
  owner: 'owner',
  name: 'repo',
  checkouts: ['/home/test/repo'],
  primaryCheckout: '/home/test/repo',
}
const pull = {
  number: 42,
  title: 'Improve review context',
  author: 'reviewer',
  headRef: 'feature',
  baseRef: 'main',
  draft: false,
}
const preflight = {
  status: 'degraded',
  checks: [
    { tool: 'git', status: 'ready' },
    { tool: 'gh', status: 'ready' },
    { tool: 'claude', status: 'ready' },
    { tool: 'codex', status: 'missing', message: 'Executable not found' },
  ],
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
function renderEntry(path = '/') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/repos/:owner/:name" element={<RepoPage />} />
        <Route path="/review/:id" element={<h1>Review opened</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Review entry screens', () => {
  it('browses directories, moves up, and registers a Git leaf without starting an agent', async () => {
    const registered: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input)
      if (url === '/api/repos' && !options?.method) return json([])
      if (url === '/api/sessions') return json([])
      if (url === '/api/preflight') return json(preflight)
      if (url.startsWith('/api/directories')) {
        const path = new URL(url, 'http://localhost').searchParams.get('path')
        return json(
          path === '/home/test/projects'
            ? {
                root: '/home/test',
                path,
                parent: '/home/test',
                repository: false,
                entries: [
                  { name: 'checkout', path: '/home/test/projects/checkout', repository: true },
                ],
                truncated: false,
              }
            : {
                root: '/home/test',
                path: '/home/test',
                repository: false,
                entries: [{ name: 'projects', path: '/home/test/projects', repository: false }],
                truncated: false,
              },
        )
      }
      if (url === '/api/repos' && options?.method === 'POST') {
        registered.push((JSON.parse(String(options.body)) as { path: string }).path)
        return json(repo, 201)
      }
      return json({ page: 1, items: [], hasNextPage: false })
    })
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    renderEntry()
    await user.click(await screen.findByRole('button', { name: 'Browse folders' }))
    await user.click(await screen.findByRole('button', { name: 'Open folder projects' }))
    expect(await screen.findByRole('button', { name: 'Open repository checkout' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Up one folder' }))
    await screen.findByRole('button', { name: 'Open folder projects' })
    await user.click(screen.getByRole('button', { name: 'Open folder projects' }))
    await user.click(await screen.findByRole('button', { name: 'Open repository checkout' }))
    expect(await screen.findByRole('heading', { name: 'owner/repo' })).toBeTruthy()
    expect(registered).toEqual(['/home/test/projects/checkout'])
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/chat/start'))).toBe(false)
  })

  it('retries a failed browse and keeps the chosen path visible if registration is rejected', async () => {
    let attempts = 0
    let attemptedPath = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
        const url = String(input)
        if (url === '/api/repos' && options?.method === 'POST') {
          attemptedPath = (JSON.parse(String(options.body)) as { path: string }).path
          return json(
            { error: { code: 'unsupported_checkout', message: 'Register a regular clone' } },
            400,
          )
        }
        if (url === '/api/repos' || url === '/api/sessions') return json([])
        if (url === '/api/preflight') return json(preflight)
        if (url.startsWith('/api/directories')) {
          if (++attempts === 1)
            return json(
              {
                error: { code: 'directory_unavailable', message: 'Folder temporarily unavailable' },
              },
              404,
            )
          return json({
            root: '/home/test',
            path: '/home/test',
            repository: false,
            entries: [{ name: 'linked ', path: '/home/test/linked ', repository: true }],
            truncated: true,
          })
        }
        return json({ page: 1, items: [], hasNextPage: false })
      }),
    )
    const user = userEvent.setup()
    renderEntry()
    await user.click(await screen.findByRole('button', { name: 'Browse folders' }))
    expect(await screen.findByText('Folder temporarily unavailable')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Retry browsing' }))
    expect(await screen.findByText(/Directory listing is limited/u)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Open repository linked/u }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Register a regular clone',
    )
    expect((screen.getByLabelText('Repository path') as HTMLInputElement).value).toBe(
      '/home/test/linked ',
    )
    expect(attemptedPath).toBe('/home/test/linked ')
    expect(screen.getByRole('button', { name: /Open repository linked/u })).toBeTruthy()
  })
  it('filters reviews, archives and restores without starting an agent, and preserves the selected filter', async () => {
    const sessions = [
      {
        id: 'draft',
        repoId: repo.id,
        prNumber: 42,
        reviewRevision: 3,
        createdAt: '2026-09-20',
        config: { main: { backend: 'claude' } },
        pullRequest: { title: 'Current draft' },
        archivedAt: undefined as string | undefined,
      },
      {
        id: 'archived',
        repoId: 'other/repo',
        prNumber: 1,
        createdAt: '2026-09-21',
        config: { main: { backend: 'claude' } },
        pullRequest: { title: 'Older archived review' },
        archivedAt: '2026-09-22',
      },
      {
        id: 'submitted',
        repoId: repo.id,
        prNumber: 10,
        createdAt: '2026-09-19',
        config: { main: { backend: 'claude' } },
        pullRequest: { title: 'Submitted receipt' },
        submission: { status: 'submitted', cleanup: { status: 'complete' } },
      },
    ]
    const calls: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input)
      if (url === '/api/repos') return json([repo])
      if (url === '/api/preflight') return json(preflight)
      if (url.endsWith('/archive')) {
        calls.push(url)
        expect(options?.headers).toMatchObject({ 'x-legible-review-revision': '3' })
        const { archived } = JSON.parse(String(options?.body)) as { archived: boolean }
        sessions[0]!.archivedAt = archived ? '2026-09-22' : undefined
        return json(sessions[0])
      }
      return json(sessions)
    })
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()
    renderEntry()
    await screen.findByText('Current draft')
    expect(screen.queryByText('Older archived review')).toBeNull()
    await user.selectOptions(screen.getByLabelText('Review status'), 'submitted')
    expect(screen.getByText('Submitted receipt')).toBeTruthy()
    expect(screen.queryByText('Current draft')).toBeNull()
    await user.selectOptions(screen.getByLabelText('Review status'), 'draft')
    await user.selectOptions(screen.getByLabelText('Repository'), repo.id)
    await user.click(screen.getByRole('button', { name: 'Archive Current draft' }))
    await screen.findByText('No matching reviews')
    expect((screen.getByLabelText('Review status') as HTMLSelectElement).value).toBe('draft')
    await user.selectOptions(screen.getByLabelText('Review status'), 'archived')
    expect(screen.queryByText('Older archived review')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Restore Current draft' }))
    await screen.findByText('No matching reviews')
    await user.selectOptions(screen.getByLabelText('Review status'), 'active')
    expect(screen.getByText('Current draft')).toBeTruthy()
    expect(calls).toEqual(['/api/sessions/draft/archive', '/api/sessions/draft/archive'])
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('/chat/'))).toBe(false)
  })

  it('keeps failed archives visible and reports the active-agent conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url === '/api/repos') return json([repo])
        if (url === '/api/preflight') return json(preflight)
        if (url.endsWith('/archive'))
          return json(
            { error: { code: 'review_busy', message: 'Stop the active agent before archiving' } },
            409,
          )
        return json([
          {
            id: 'busy',
            repoId: repo.id,
            prNumber: 42,
            createdAt: '2026-09-20',
            config: { main: { backend: 'claude' } },
            pullRequest: { title: 'Running review' },
          },
        ])
      }),
    )
    const user = userEvent.setup()
    renderEntry()
    await user.click(await screen.findByRole('button', { name: 'Archive Running review' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Stop the active agent before archiving',
    )
    expect(screen.getByText('Running review')).toBeTruthy()
  })
  it('prefills a CLI PR link without automatically preparing a review', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({ page: 1, items: [], hasNextPage: false }),
    )
    vi.stubGlobal('fetch', fetcher)
    renderEntry('/repos/owner/repo?pr=42')
    expect((screen.getByLabelText('Pull request number') as HTMLInputElement).value).toBe('42')
    await screen.findByText('No open pull requests')
    expect(fetcher.mock.calls.every((call) => !call[1]?.method)).toBe(true)
    expect(screen.getByRole('button', { name: 'Open review' })).toBeTruthy()
  })

  it.each(['0', '-1', '1e3', '9007199254740992', 'bad'])(
    'ignores invalid CLI PR query %s',
    (pr) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json({ page: 1, items: [], hasNextPage: false })),
      )
      renderEntry(`/repos/owner/repo?pr=${pr}`)
      expect((screen.getByLabelText('Pull request number') as HTMLInputElement).value).toBe('')
    },
  )

  it('registers a path, selects PR and advanced settings, and opens without starting an agent', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
        const url = String(input)
        if (options?.method === 'POST') {
          calls.push({ url, body: JSON.parse(String(options.body)) })
          return json(url === '/api/repos' ? repo : { session: { id: 'session-1' }, reused: false })
        }
        if (url === '/api/repos' || url === '/api/sessions') return json([])
        if (url === '/api/preflight') return json(preflight)
        return json({ page: 1, items: [pull], hasNextPage: false })
      }),
    )
    const user = userEvent.setup()
    renderEntry()
    expect(await screen.findByText('No reviews yet')).toBeTruthy()
    await user.type(screen.getByLabelText('Repository path'), '/home/test/repo')
    await user.click(screen.getByRole('button', { name: 'Open repository' }))
    expect(await screen.findByRole('heading', { name: 'owner/repo' })).toBeTruthy()
    await user.selectOptions(screen.getByLabelText('Backend'), AgentBackendKind.Codex)
    await user.click(screen.getByText('Advanced settings'))
    await user.type(screen.getByLabelText('Model'), 'custom-model')
    await user.type(screen.getByLabelText('Effort'), 'custom-effort')
    await user.click(await screen.findByRole('button', { name: /Improve review context/u }))
    expect(await screen.findByRole('heading', { name: 'Review opened' })).toBeTruthy()
    expect(calls).toEqual([
      { url: '/api/repos', body: { path: '/home/test/repo' } },
      {
        url: '/api/sessions',
        body: {
          repoId: 'owner/repo',
          prNumber: 42,
          config: {
            main: {
              backend: 'codex',
              shell: 'broad',
              network: 'off',
              onOutOfScope: 'deny',
              model: 'custom-model',
              effort: 'custom-effort',
            },
          },
        },
      },
    ])
  })

  it('shows PR list failure, retries, paginates, and accepts an explicit PR number', async () => {
    let attempts = 0
    const fetch = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input)
      if (options?.method === 'POST') return json({ session: { id: 'session-2' }, reused: true })
      if (++attempts === 1)
        return json(
          { error: { code: 'github_request_failed', message: 'GitHub unavailable' } },
          502,
        )
      return json({
        page: url.endsWith('page=2') ? 2 : 1,
        items: [],
        hasNextPage: !url.endsWith('page=2'),
      })
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    renderEntry('/repos/owner/repo')
    expect(await screen.findByText('GitHub unavailable')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No open pull requests')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('Page 2')).toBeTruthy()
    await user.type(screen.getByLabelText('Pull request number'), '123')
    await user.click(screen.getByRole('button', { name: 'Open review' }))
    expect(await screen.findByRole('heading', { name: 'Review opened' })).toBeTruthy()
    expect(fetch.mock.calls.some(([, options]) => String(options?.body).includes('123'))).toBe(true)
  })

  it('shows recent reviews and setup status, and records reopening', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === '/api/repos') return json([repo])
      if (url === '/api/preflight' || url.endsWith('/refresh')) return json(preflight)
      if (url.endsWith('/open')) return json({ id: 'existing' })
      return json([
        {
          id: 'existing',
          repoId: repo.id,
          prNumber: 42,
          config: { main: { backend: 'claude' } },
          createdAt: '2026-09-13T00:00:00Z',
          pullRequest: { title: 'Saved review' },
        },
      ])
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    renderEntry()
    expect(await screen.findByText('Executable not found')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() =>
      expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/refresh'))).toBe(true),
    )
    await user.click(await screen.findByRole('button', { name: /^Saved review/u }))
    expect(await screen.findByRole('heading', { name: 'Review opened' })).toBeTruthy()
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/existing/open'))).toBe(true)
  })
})
