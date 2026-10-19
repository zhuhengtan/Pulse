import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { routingFixture } from './fixtures/routing.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
const routers: ReturnType<typeof createMemoryRouter>[] = []
afterEach(() => { cleanup(); routers.splice(0).forEach(router => router.dispose()); localStorage.clear(); vi.restoreAllMocks() })
const response = (body: unknown) => Response.json(body)
const artifact = (runId: string, path: string) => ({ runId, path, absolutePath: `/isolated/${path}`, workspaceState: 'isolated' })
function show(emptyMessages = false) {
  const fixture = routingFixture(), request = fixture.transport.request, artifactCalls: string[] = []
  let resolveOld: ((r: Response) => void) | undefined
  fixture.transport.request = async (path, init) => {
    if (path === '/api/web/conversations/pulse-chat/messages') return response(emptyMessages ? [] : [
      { id: 'u1', role: 'user', text: '第一轮', runId: 'run-1' },
      { id: 'a1', role: 'assistant', text: '先说明', runId: 'run-1' },
      { id: 'a2', role: 'assistant', text: '第一轮完成', runId: 'run-1' },
      { id: 'u2', role: 'user', text: '第二轮', runId: 'run-2' },
      { id: 'a3', role: 'assistant', text: '第二轮完成', runId: 'run-2' },
    ].map(m => ({ ...m, createdAt: '2026-10-19T00:00:00Z' })))
    if (path.startsWith('/api/conversations/pulse-chat/artifacts') && !path.includes('/content?')) {
      artifactCalls.push(path)
      return response([artifact('run-1', 'docs/first.md'), artifact('run-2', 'docs/second.md')])
    }
    if (path.startsWith('/api/conversations/old/artifacts') && !path.includes('/content?')) return new Promise<Response>(resolve => { resolveOld = resolve })
    if (path.includes('/artifacts/content?')) return response({ content: `正文 ${new URL(path, 'http://fixture').searchParams.get('runId')}` })
    return request(path, init)
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: ['/work/pulse-chat'] }); routers.push(router)
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  return { ...view, router, artifactCalls, resolveOld: () => resolveOld?.(response([artifact('old-run', 'stale.md')])) }
}
it('places each delivery after the last message of its run and before the next turn, fetching the index once', async () => {
  const view = show()
  await screen.findAllByText(/docs\/second\.md/)
  const first = screen.getByText('第一轮完成').closest('.message')!, secondUser = screen.getByText('第二轮').closest('.message')!
  const cards = view.container.querySelectorAll('.conversation-artifacts')
  expect(cards).toHaveLength(2)
  expect(first.nextElementSibling).toBe(cards[0])
  expect(cards[0]!.nextElementSibling).toBe(secondUser)
  expect(screen.getByText('第二轮完成').closest('.message')!.nextElementSibling).toBe(cards[1])
  expect(within(cards[0] as HTMLElement).getByText('docs/first.md')).toBeTruthy()
  expect(within(cards[0] as HTMLElement).queryByText('docs/second.md')).toBeNull()
  expect(view.artifactCalls).toHaveLength(1)
})
it('opens a preview only in its owning turn and restores it through browser history', async () => {
  const view = show()
  await screen.findAllByText(/docs\/second\.md/)
  const first = screen.getByText('docs/first.md').closest('section')!
  fireEvent.click(within(first).getByRole('button', { name: '查看' }))
  await screen.findByText('正文 run-1')
  expect(view.router.state.location.search).toContain('artifactRun=run-1')
  expect(within(screen.getByText('docs/second.md').closest('section')!).queryByText('正文 run-1')).toBeNull()
  await act(async () => { await view.router.navigate(-1) })
  await waitFor(() => expect(screen.queryByText('正文 run-1')).toBeNull())
  await act(async () => { await view.router.navigate(1) })
  expect(await screen.findByText('正文 run-1')).toBeTruthy()
})
it('ignores an artifact response from a conversation that was left', async () => {
  const view = show()
  await screen.findByText('docs/first.md')
  await act(async () => { await view.router.navigate('/work/old') })
  await screen.findByText('消息：old')
  expect(screen.queryByText('docs/first.md')).toBeNull()
  await act(async () => { await view.router.navigate('/work/pulse-chat') })
  await screen.findByText('docs/first.md')
  await act(async () => view.resolveOld())
  expect(screen.queryByText('stale.md')).toBeNull()
})

it('keeps legacy deliveries accessible when their message history is missing', async () => {
  const view = show(true)
  await screen.findByText('docs/first.md')
  expect(view.container.querySelector('.messages')?.classList.contains('is-empty')).toBe(false)
  expect(screen.queryByText('我们要做什么？')).toBeNull()
  expect(screen.getAllByRole('region', { name: '本轮交付文件' })).toHaveLength(2)
})
