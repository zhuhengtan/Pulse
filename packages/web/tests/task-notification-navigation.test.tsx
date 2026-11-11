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

function show(target: string, assistantTarget = false, shared = false, options: { onlyA?: boolean; hold?: Promise<void>; same?: boolean } = {}) {
  const fixture = routingFixture(), request = fixture.transport.request, posts: Array<{ path: string; body: any }> = []
  const question = (id: string) => ({ groupId: shared ? 'wait-1' : id, kind: 'ask', items: [{ effectId: options.same ? 'effect-1' : `effect-${id}`, input: { type: 'input', prompt: options.same ? '共同问题' : `问题 ${id}` } }] })
  let groups = options.onlyA ? ['A'] : ['A', 'B']
  const changed = new Set<() => void>()
  fixture.transport.onChange = listener => { changed.add(listener); return () => { changed.delete(listener) } }
  fixture.transport.request = async (path, init) => {
    // Every Runtime numbers its waits from wait-1, so two runs can own the same native group id.
    if (shared && path === '/api/notifications') { await options.hold; return Response.json(['A', 'B'].map(id => ({ id: 'notice-' + id, revision: options.same ? 'revision-same' : 'revision-' + id, kind: 'ask', conversationId: 'conversation-' + id, runId: 'run-' + id, groupId: 'wait-1', surface: 'chat' }))) }
    if (path === '/api/assistant') return Response.json({
      conversation: { id: 'assistant', title: 'Pulse 助理', cwd: '/example', createdAt: '2026-10-25', updatedAt: '2026-10-25' }, messages: groups.filter(id => !assistantTarget || id !== 'B').map(id => ({ id: `callback-${id}`, role: 'assistant', text: `任务 ${id} 有个问题`, createdAt: '2026-10-25', workAction: { callbackId: `callback-${id}`, conversationId: `conversation-${id}`, runId: `run-${id}`, controlRevision: 0, fingerprint: `hash-${id}`, interaction: question(id) } })),
      receipts: assistantTarget ? [{ messageId: 'message', runId: 'run-B', state: 'replying' }] : [],
      workInteractions: groups.filter(id => !assistantTarget || id !== 'B').map(id => ({ ...question(id), runId: `run-${id}`, conversationId: `conversation-${id}`, title: `任务 ${id}` })),
    })
    if (path === '/api/runs/run-B/state' && assistantTarget) return Response.json({ runId: 'run-B', state: 'running', seq: 0, activities: [], interactions: groups.includes('B') ? [question('B')] : [] })
    if (path.endsWith('/replies')) {
      const body = JSON.parse(String(init?.body)); posts.push({ path, body }); groups = groups.filter(id => id !== (body.groupId ?? body.callbackId?.replace('callback-', '')))
      queueMicrotask(() => changed.forEach(listener => listener()))
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
  expect(view.posts[0]).toMatchObject(assistantTarget ? { path: '/api/runs/run-B/replies', body: { groupId: 'B', conversationId: 'assistant', answers: [{ effectId: 'effect-B', value: { text: '回答 B' } }] } } : { path: '/api/assistant/work/conversation-B/replies', body: { callbackId: 'callback-B', fingerprint: 'hash-B', answers: [{ effectId: 'effect-B', value: { text: '回答 B' } }] } })
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

it.each(['wait-1&noticeRevision=revision-B', 'wait-1&noticeRevision=revision-B&noticeRun=run-B'])('isolates native group IDs that collide across runs (%s)', async target => {
  const view = show(target, false, true)
  await view.findByRole('heading', { name: '问题 B' })
  expect(view.queryByRole('heading', { name: '问题 A' })).toBeNull()
  fireEvent.change(view.getByRole('textbox', { name: '你的答案' }), { target: { value: '回答 B' } })
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(view.posts).toHaveLength(1))
  expect(view.posts[0]).toMatchObject({ path: '/api/assistant/work/conversation-B/replies', body: { callbackId: 'callback-B', fingerprint: 'hash-B', answers: [{ effectId: 'effect-B', value: { text: '回答 B' } }] } })
})

it('opens no question for an ambiguous bare group or an unknown revision shared by several runs', async () => {
  for (const target of ['wait-1', 'wait-1&noticeRevision=revision-gone']) {
    const view = show(target, false, true)
    await view.findByText('通知对应的问题已处理或暂不可用，请查看任务记录。')
    expect(view.queryByRole('heading', { name: '问题 A' })).toBeNull()
    expect(view.queryByRole('heading', { name: '问题 B' })).toBeNull()
    expect(view.posts).toEqual([])
    cleanup()
  }
})

it('does not open the only current question for an expired revision, with or without a run', async () => {
  for (const target of ['wait-1&noticeRevision=expired-revision', 'wait-1&noticeRevision=expired-revision&noticeRun=run-A', 'wait-1&noticeRevision=revision-B&noticeRun=run-A']) {
    const view = show(target, false, true, { onlyA: true })
    await view.findByText('通知对应的问题已处理或暂不可用，请查看任务记录。')
    expect(view.queryByRole('heading', { name: '问题 A' })).toBeNull()
    expect(view.queryByRole('button', { name: '提交回答' })).toBeNull()
    expect(view.posts).toEqual([])
    cleanup()
  }
})

it('keeps every answerable form hidden while the notice revision is still being resolved', async () => {
  let release!: () => void
  const view = show('wait-1&noticeRevision=revision-B', false, true, { hold: new Promise<void>(resolve => { release = resolve }) })
  await view.findByText('正在查找通知对应的问题…')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(view.queryByRole('heading', { name: /问题 [AB]/ })).toBeNull()
  expect(view.queryByRole('textbox', { name: '你的答案' })).toBeNull()
  release()
  await view.findByRole('heading', { name: '问题 B' })
  expect(view.queryByRole('heading', { name: '问题 A' })).toBeNull()
})

it('retargets run and group when the user locates another run that shares the group id', async () => {
  const view = show('wait-1&noticeRevision=revision-B&noticeRun=run-B', false, true)
  await view.findByRole('heading', { name: '问题 B' })
  fireEvent.change(view.getByRole('textbox', { name: '你的答案' }), { target: { value: '草稿 B' } })
  fireEvent.click(view.getByRole('button', { name: '查看待回答问题：任务 A' }))
  await view.findByRole('heading', { name: '问题 A' })
  expect(view.queryByRole('heading', { name: '问题 B' })).toBeNull()
  expect(Object.fromEntries(new URLSearchParams(view.router.state.location.search))).toEqual({ notification: 'wait-1', noticeRun: 'run-A' })
  expect((view.getByRole('textbox', { name: '你的答案' }) as HTMLTextAreaElement).value).toBe('')
  fireEvent.change(view.getByRole('textbox', { name: '你的答案' }), { target: { value: '回答 A' } })
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(view.posts).toHaveLength(1))
  expect(view.posts[0]).toMatchObject({ path: '/api/assistant/work/conversation-A/replies', body: { callbackId: 'callback-A', fingerprint: 'hash-A', answers: [{ effectId: 'effect-A', value: { text: '回答 A' } }] } })
})

// The native revision hashes only the group, so identical waits of two runs share group id, effect id, prompt and revision.
it('opens the explicit run when two runs have identical native group hashes', async () => {
  const view = show('wait-1&noticeRevision=revision-same&noticeRun=run-B', false, true, { same: true })
  await view.findByRole('heading', { name: '共同问题' })
  expect(view.getAllByRole('heading', { name: '共同问题' })).toHaveLength(1)
  fireEvent.change(view.getByRole('textbox', { name: '你的答案' }), { target: { value: '回答' } })
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(view.posts).toHaveLength(1))
  expect(view.posts[0]).toMatchObject({ path: '/api/assistant/work/conversation-B/replies', body: { callbackId: 'callback-B', fingerprint: 'hash-B' } })
})

it('does not guess a run for a revision-only link shared by several runs', async () => {
  const view = show('wait-1&noticeRevision=revision-same', false, true, { same: true })
  await view.findByText('通知对应的问题已处理或暂不可用，请查看任务记录。')
  expect(view.queryByRole('heading', { name: '共同问题' })).toBeNull()
  expect(view.queryByRole('button', { name: '提交回答' })).toBeNull()
  expect(view.posts).toEqual([])
})

it('re-resolves when only noticeRun changes under the same group and revision', async () => {
  const view = show('wait-1&noticeRevision=revision-same&noticeRun=run-A', false, true, { same: true })
  await view.findByRole('heading', { name: '共同问题' })
  fireEvent.change(view.getByRole('textbox', { name: '你的答案' }), { target: { value: '草稿 A' } })
  await act(async () => { await view.router.navigate('/chat?notification=wait-1&noticeRevision=revision-same&noticeRun=run-B') })
  await waitFor(() => expect((view.getByRole('textbox', { name: '你的答案' }) as HTMLTextAreaElement).value).toBe(''))
  expect(view.getAllByRole('heading', { name: '共同问题' })).toHaveLength(1)
  fireEvent.change(view.getByRole('textbox', { name: '你的答案' }), { target: { value: '回答 B' } })
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(view.posts).toHaveLength(1))
  expect(view.posts[0]).toMatchObject({ path: '/api/assistant/work/conversation-B/replies', body: { callbackId: 'callback-B', fingerprint: 'hash-B', answers: [{ effectId: 'effect-1', value: { text: '回答 B' } }] } })
})
