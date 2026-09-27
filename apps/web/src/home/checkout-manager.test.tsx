// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { CheckoutManager } from './checkout-manager.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const repo = {
  id: 'owner/repo',
  owner: 'owner',
  name: 'repo',
  primaryCheckout: '/first',
  checkouts: ['/first', '/second'],
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

it('changes primary and confirms registration-only removal without deleting files', async () => {
  const current = structuredClone(repo)
  const mutations: Array<{ method: string; path: string }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, options?: RequestInit) => {
      if (options?.method) {
        const { path } = JSON.parse(String(options.body)) as { path: string }
        mutations.push({ method: options.method, path })
        if (options.method === 'PATCH') current.primaryCheckout = path
        else current.checkouts = current.checkouts.filter((entry) => entry !== path)
        return json(current)
      }
      return json({
        repo: current,
        sessionCount: 0,
        checkouts: current.checkouts.map((path) => ({ path, available: true })),
      })
    }),
  )
  const user = userEvent.setup()
  render(<CheckoutManager repo={repo} onClose={() => undefined} onRemoved={() => undefined} />)
  await user.click(await screen.findByRole('button', { name: 'Make primary' }))
  await waitFor(() =>
    expect(screen.getByText('/second').closest('li')?.textContent).toContain('Primary'),
  )
  await user.click(screen.getByRole('button', { name: 'Forget path' }))
  const confirmation = screen.getByRole('group', { name: 'Confirm forgetting path' })
  expect(within(confirmation).getByText(/local checkout stays on disk/u)).toBeTruthy()
  expect(mutations).toHaveLength(1)
  await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }))
  expect(mutations).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: 'Forget path' }))
  await user.click(screen.getByRole('button', { name: 'Confirm forget' }))
  await screen.findByText('/second')
  expect(screen.queryByText('/first')).toBeNull()
  expect(mutations).toEqual([
    { method: 'PATCH', path: '/second' },
    { method: 'DELETE', path: '/first' },
  ])
})

it('shows unavailable paths, blocks dependent primary changes and handles failed removal', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, options?: RequestInit) =>
      options?.method
        ? json({ error: { code: 'repo_store_failed', message: 'Unable to save registry' } }, 500)
        : json({
            repo,
            sessionCount: 2,
            primaryChangeBlocked: 'Saved reviews depend on this primary checkout',
            checkouts: [
              { path: '/first', available: true },
              { path: '/second', available: false, message: 'Checkout disappeared' },
            ],
          }),
    ),
  )
  const user = userEvent.setup()
  render(<CheckoutManager repo={repo} onClose={() => undefined} onRemoved={() => undefined} />)
  expect(await screen.findByText('Checkout disappeared')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Make primary' })).toHaveProperty('disabled', true)
  expect(screen.getByText(/2 saved reviews/u)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Forget path' }))
  await user.click(screen.getByRole('button', { name: 'Confirm forget' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Unable to save registry')
  expect(screen.getByText('/second')).toBeTruthy()
})
