import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { routingFixture } from './fixtures/routing.js'

beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON() {} })
})
const routers: ReturnType<typeof createMemoryRouter>[] = []
afterEach(() => { cleanup(); routers.splice(0).forEach(router => router.dispose()); localStorage.clear(); vi.restoreAllMocks() })

function show(target: string, assistantTarget = false) {
  const fixture = routingFixture(), request = fixture.transport.request, posts: Array<{ path: string; body: any }> = []
  const question = (id: string) => ({ groupId: id, kind: 'ask', items: [{ effectId: `effect-${id}`, input: { type: 'input', prompt: `问题 ${id}` } }] })
  let groups = ['A', 'B']
  fixture.transport.request = async (path, init) => {
    if (path === '/api/assistant') return Response.json({
      conversation: { id: 'assistant', title: 'Pulse 助理', cwd: '/example', createdAt: '2026-10-25', updatedAt: '2026-10-25' }, messages: [],
      receipts: assistantTarget ? [{ messageId: 'message', runId: 'run-B', state: 'replying' }] : [],
      workInteractions: groups.filter(id => !assistantTarget || id !== 'B').map(id => ({ ...question(id), runId: `run-${id}`, conversationId: `conversation-${id}`, title: `任务 ${id}` })),
    })
    if (path === '/api/runs/run-B/state' && assistantTarget) return Response.json({ runId: 'run-B', state: 'running', seq: 0, activities: [], interactions: groups.includes('B') ? [question('B')] : [] })
    if (path.endsWith('/replies')) {
      const body = JSON.parse(String(init?.body)); posts.push({ path, body }); groups = groups.filter(id => id !== body.groupId)
      return Response.json({ ok: true })
    }
    return request(path, init)
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: [`/chat?notification=${target}`] })
  routers.push(router)
  return { ...render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>), router, posts }
}

it.each([false, true])('selects notification B ahead of pending work A (assistant target: %s)', async assistantTarget => {
  const view = show('B', assistantTarget)
  await view.findByRole('heading', { name: '问题 B' })
  expect(view.queryByRole('heading', { name: '问题 A' })).toBeNull()
  expect(view.router.state.location.search).toBe('?notification=B')
  expect(document.activeElement).toBe(view.getByRole('textbox', { name: '你的答案' }))
  fireEvent.change(view.getByRole('textbox', { name: '你的答案' }), { target: { value: '回答 B' } })
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(view.posts).toHaveLength(1))
  expect(view.posts[0]).toMatchObject({ path: '/api/runs/run-B/replies', body: { groupId: 'B', conversationId: assistantTarget ? 'assistant' : 'conversation-B', answers: [{ effectId: 'effect-B', value: { text: '回答 B' } }] } })
  await view.findByText('通知对应的问题已处理或暂不可用，请查看任务记录。')
  expect(view.queryByRole('heading', { name: '问题 A' })).toBeNull()
})

it('keeps missing or expired targets separate from other pending questions until explicitly opened', async () => {
  const view = show('expired')
  await view.findByText('通知对应的问题已处理或暂不可用，请查看任务记录。')
  expect(view.queryByRole('heading', { name: '问题 A' })).toBeNull()
  expect(view.queryByRole('button', { name: '提交回答' })).toBeNull()
  expect(view.posts).toEqual([])
  fireEvent.click(view.getByRole('button', { name: '查看其他待办' }))
  await view.findByRole('heading', { name: '问题 A' })
  expect(view.router.state.location.search).toBe('')
  expect(view.posts).toEqual([])
})

it('switches targets on the same page without retaining the previous question or draft', async () => {
  const view = show('A')
  await view.findByRole('heading', { name: '问题 A' })
  fireEvent.change(view.getByRole('textbox', { name: '你的答案' }), { target: { value: '草稿 A' } })
  await act(async () => { await view.router.navigate('/chat?notification=B') })
  await view.findByRole('heading', { name: '问题 B' })
  expect((view.getByRole('textbox', { name: '你的答案' }) as HTMLTextAreaElement).value).toBe('')
  expect(view.posts).toEqual([])
})
