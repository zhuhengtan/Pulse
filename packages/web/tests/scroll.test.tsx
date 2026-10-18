import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { routingFixture } from './fixtures/routing.js'
import type { WebRunEvent } from '../src/transport.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const getStyle = window.getComputedStyle.bind(window); window.getComputedStyle = element => getStyle(element)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollTo = () => {}
})
const calls: Array<{ from: number; behavior?: ScrollBehavior }> = []
const routers: ReturnType<typeof createMemoryRouter>[] = []
beforeEach(() => {
  localStorage.clear(); calls.length = 0
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function () { return this.classList.contains('messages') ? 5000 : 0 })
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function () { return this.classList.contains('messages') ? 500 : 0 })
  vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(function (options: ScrollToOptions | number) {
    if (!this.classList.contains('messages') || typeof options === 'number') return
    calls.push({ from: this.scrollTop, behavior: options.behavior })
    this.scrollTop = Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight)
  })
})
afterEach(() => { cleanup(); routers.splice(0).forEach(router => router.dispose()); vi.restoreAllMocks() })
function show(url: string, fixture = routingFixture()) {
  const request = fixture.transport.request
  fixture.transport.request = async (path, init) => {
    const response = await request(path, init)
    if (path !== '/api/assistant') return response
    const view = await response.json()
    return new Response(JSON.stringify({ ...view, messages: [{ id: 'latest', role: 'assistant', text: '最新助手消息', createdAt: '2026-10-18T00:00:00Z' }] }))
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: [url] })
  routers.push(router)
  render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  return { router, fixture }
}
const messages = () => screen.getByRole('region', { name: '聊天消息' })
const navigate = async (router: ReturnType<typeof createMemoryRouter>, path: string) => { await act(async () => { await router.navigate(path) }) }

it('waits for history to load and opens the assistant directly at the bottom without a smooth scroll', async () => {
  const fixture = routingFixture(), request = fixture.transport.request
  let release!: () => void
  let requested = false
  const gate = new Promise<void>(resolve => { release = resolve })
  fixture.transport.request = async (path, init) => {
    if (path === '/api/assistant') { requested = true; await gate }
    return request(path, init)
  }
  show('/chat', fixture)
  await waitFor(() => expect(requested).toBe(true))
  expect(calls).toEqual([])
  await act(async () => { release() })
  await screen.findByText('最新助手消息')
  expect(messages().scrollTop).toBe(4500)
  expect(calls.every(call => call.behavior === 'instant')).toBe(true)
})

it('resets a previous history-reading position when switching conversations or returning from settings', async () => {
  const { router } = show('/chat')
  await screen.findByText('最新助手消息')
  messages().scrollTop = 120; fireEvent.scroll(messages())
  expect(screen.getByRole('button', { name: '回到底部 ↓' })).toBeTruthy()
  calls.length = 0
  await navigate(router, '/work/pulse-chat'); await screen.findByText('消息：pulse-chat')
  expect(messages().scrollTop).toBe(4500)
  expect(screen.queryByRole('button', { name: '回到底部 ↓' })).toBeNull()
  messages().scrollTop = 80; fireEvent.scroll(messages())
  await navigate(router, '/settings/appearance')
  await navigate(router, '/chat'); await screen.findByText('最新助手消息')
  expect(messages().scrollTop).toBe(4500)
  expect(calls.every(call => call.behavior === 'instant')).toBe(true)
})

it('keeps the reading position on streamed updates and lets the user explicitly jump back to the bottom', async () => {
  const fixture = routingFixture()
  let receive!: (event: WebRunEvent) => void
  fixture.transport.subscribe = (_path, onEvent) => { receive = onEvent; return () => {} }
  show('/work/busy', fixture)
  await screen.findByText('消息：busy')
  await waitFor(() => expect(receive).toBeTypeOf('function'))
  messages().scrollTop = 200; fireEvent.scroll(messages()); calls.length = 0
  act(() => { receive({ type: 'text', runId: 'run-busy', seq: 1, data: '新的工作消息' }) })
  await screen.findByText('新的工作消息')
  expect(messages().scrollTop).toBe(200)
  expect(calls).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '回到底部 ↓' }))
  expect(messages().scrollTop).toBe(4500)
  expect(calls.at(-1)?.behavior).toBe('smooth')
  calls.length = 0
  act(() => { receive({ type: 'text', runId: 'run-busy', seq: 2, data: '持续输出的工作消息' }) })
  await screen.findByText('持续输出的工作消息')
  expect(calls.every(call => call.behavior === 'instant')).toBe(true)
})
