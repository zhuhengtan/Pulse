import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { routingFixture } from './fixtures/routing.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
})
const routers: ReturnType<typeof createMemoryRouter>[] = []
afterEach(() => { cleanup(); routers.splice(0).forEach(router => router.dispose()); localStorage.clear() })

const now = '2026-11-06T00:00:00.000Z'
const conversationId = 'notice-chat'
const runId = 'run-notice'
const shownItems = [{ effectId: 'effect-shown', input: { type: 'input', prompt: '当前问题' } }]
const hiddenItems = [{ effectId: 'effect-shown', input: { type: 'input', prompt: '尚未显示的新问题' } }]
const notice = { id: 'interaction:run-notice:g', revision: 'rev-new', conversationId, runId, groupId: 'g', kind: 'ask' }

function show(options: { failState?: boolean; holdNotices?: boolean; link?: string } = {}) {
  const fixture = routingFixture()
  const base = fixture.transport.request
  const reads: unknown[] = []
  const waiters: Array<() => void> = []
  let items = shownItems
  let currentNotice = notice
  let stateCalls = 0
  const searches: string[] = []
  let routerRef: ReturnType<typeof createMemoryRouter> | undefined
  const conversation = { id: conversationId, title: '通知验收', cwd: '/example', createdAt: now, updatedAt: now, activeRunId: runId }
  const transport: PulseWebTransport = {
    ...fixture.transport,
    request: async (path, init) => {
      if (path === '/api/conversations') return Response.json([conversation])
      if (path === `/api/conversations/${conversationId}`) return Response.json(conversation)
      if (path === `/api/web/conversations/${conversationId}/messages`) return Response.json([{ id: 'message', role: 'assistant', text: '已提出问题', createdAt: now, runId }])
      if (path === `/api/runs/${runId}/state`) {
        stateCalls += 1
        if (options.failState && stateCalls > 2) return Response.json({ error: 'unavailable' }, { status: 503 })
        return Response.json({ runId, state: options.failState ? 'interrupted' : 'running', seq: 0, activities: [], interactions: [{ groupId: 'g', kind: 'ask', items }] })
      }
      if (path === '/api/notifications') {
        searches.push(routerRef?.state.location.search ?? '')
        if (options.holdNotices) await new Promise<void>(resolve => waiters.push(resolve))
        return Response.json([currentNotice])
      }
      if (path === '/api/notifications/read' && init?.method === 'POST') {
        reads.push(JSON.parse(String(init.body)))
        return Response.json({ ok: true })
      }
      return base(path, init)
    },
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={transport}/> }], { initialEntries: [`/work/${conversationId}${options.link ?? '?notification=g&noticeRevision=rev-new&noticeRun=run-notice'}`] })
  routers.push(router); routerRef = router
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  return { ...view, reads, router, waiters, searches, stateCalls: () => stateCalls, replace(nextItems: typeof shownItems, revision: string) { items = nextItems; currentNotice = { ...notice, revision } } }
}

it('posts the displayed revision after a verified notice URL opens the current question', async () => {
  const view = show()
  await view.findByRole('heading', { name: '当前问题' })
  await waitFor(() => expect(view.reads).toEqual([{ targets: [{ id: notice.id, revision: 'rev-new' }] }]))
  // Normalization keeps the legitimate target identity fields.
  expect(Object.fromEntries(new URLSearchParams(view.router.state.location.search))).toEqual({ notification: 'g', noticeRevision: 'rev-new', noticeRun: 'run-notice' })
  console.info('notification fetch URLs', JSON.stringify(view.searches))
})

it('does not post when the displayed snapshot cannot be loaded', async () => {
  const view = show({ failState: true })
  await view.findByRole('heading', { name: '当前问题' })
  await waitFor(() => expect(view.stateCalls()).toBeGreaterThan(2))
  expect(view.reads).toEqual([])
})

it('does not clear a revision that arrives before it is displayed', async () => {
  // A link without any revision/run identity may fall back to its unique pending group while the notice list is held.
  const view = show({ holdNotices: true, link: '?notification=g' })
  await view.findByRole('heading', { name: '当前问题' })
  await waitFor(() => expect(view.waiters.length).toBeGreaterThan(0))
  view.replace(hiddenItems, 'rev-hidden')
  view.waiters.splice(0).forEach(release => release())
  await new Promise(resolve => setTimeout(resolve, 80))
  expect(view.reads).toEqual([])
  expect(screen.getByRole('heading', { name: '当前问题' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '尚未显示的新问题' })).toBeNull()
})
