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
    await user.click(await screen.findByRole('button', { name: /Saved review/u }))
    expect(await screen.findByRole('heading', { name: 'Review opened' })).toBeTruthy()
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/existing/open'))).toBe(true)
  })
})
