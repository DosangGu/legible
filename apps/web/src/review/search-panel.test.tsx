// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { SearchPanel } from './search-panel.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const sha = 'a'.repeat(40)
const response = (query: string, revision = 0) =>
  new Response(
    JSON.stringify({
      query,
      reviewRevision: revision,
      headSha: sha,
      matches: [{ path: 'helper.ts', line: 10, preview: query }],
      truncated: true,
      skippedLargeFiles: 2,
    }),
  )

it('ignores superseded queries and displays limit notices, errors, and retry results', async () => {
  const open = vi.fn()
  let finishFirst!: (response: Response) => void
  let requestNumber = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      requestNumber++
      if (requestNumber === 1)
        return new Promise<Response>((resolve) => {
          finishFirst = resolve
        })
      if (requestNumber === 2)
        return new Response(
          JSON.stringify({ error: { code: 'search_busy', message: 'Search busy' } }),
          { status: 429 },
        )
      return response('second')
    }),
  )
  const user = userEvent.setup()
  render(<SearchPanel sessionId="session" revision={0} headSha={sha} onOpen={open} />)
  await user.type(screen.getByRole('searchbox'), 'first')
  await user.click(screen.getByRole('button', { name: 'Search code' }))
  await user.clear(screen.getByRole('searchbox'))
  await user.type(screen.getByRole('searchbox'), 'second')
  await user.click(screen.getByRole('button', { name: 'Search code' }))
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Search busy Submit the query to retry.',
  )
  await user.click(screen.getByRole('button', { name: 'Search code' }))
  expect(await screen.findByText('2 files over 1 MiB skipped.')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Results limited')
  finishFirst(response('first'))
  await user.click(screen.getByRole('button', { name: /helper.ts:10/ }))
  expect(open).toHaveBeenCalledWith({ path: 'helper.ts', line: 10, preview: 'second' }, 'second')
  expect(screen.queryByText('first')).toBeNull()
})

it('aborts an old revision and never renders its late response', async () => {
  let resolve!: (response: Response) => void
  let signal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined
      return new Promise<Response>((done) => {
        resolve = done
      })
    }),
  )
  const user = userEvent.setup()
  const view = render(
    <SearchPanel key="0" sessionId="session" revision={0} headSha={sha} onOpen={() => undefined} />,
  )
  await user.type(screen.getByRole('searchbox'), 'old')
  await user.click(screen.getByRole('button', { name: 'Search code' }))
  view.rerender(
    <SearchPanel key="1" sessionId="session" revision={1} headSha={sha} onOpen={() => undefined} />,
  )
  expect(signal?.aborted).toBe(true)
  resolve(response('old'))
  await waitFor(() => expect(screen.queryByText('helper.ts:10')).toBeNull())
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
})
