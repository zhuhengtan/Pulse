import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { routingFixture } from './fixtures/routing.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

function fixture({ messages = false, snapshotFailure = false, traceFailure = false, state = 'interrupted' } = {}) {
  const f = routingFixture(), request = f.transport.request
  let resume: () => Promise<Response> = async () => response({ runId: 'run-next' })
  let reconcile: () => Promise<Response> = async () => response({ cleared: true })
  let snapshot: () => Promise<Response> = async () => response({ runId: 'run-busy', state, seq: 0, activities: [] }, snapshotFailure ? 503 : 200)
  const mutations: string[] = []
  f.transport.request = async (path, init) => {
    if (path.endsWith('/runs/run-busy/resume')) { mutations.push('resume'); return resume() }
    if (path.endsWith('/runs/run-busy/reconcile')) { mutations.push('end'); return reconcile() }
    if (path === '/api/runs/run-busy/state') return snapshot()
    if (path === '/api/web/conversations/busy/messages') return response(messages ? [{ id: 'm1', runId: 'run-busy', role: 'assistant', text: '已有任务记录', createdAt: new Date().toISOString() }] : [])
    if (path === '/api/web/conversations/busy/traces') return response({ traces: messages ? [{ runId: 'run-busy', events: [{ type: 'lanes', runId: 'run-busy', seq: 1, data: { available: true, lanes: [{ id: 'main', label: '主任务', status: 'waiting' }] } }] }] : [] }, traceFailure ? 503 : 200)
    return request(path, init)
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={f.transport}/> }], { initialEntries: ['/work/busy?task=1&lane=main'] })
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  return { ...f, ...view, router, mutations, resume: (next: typeof resume) => { resume = next }, end: (next: typeof reconcile) => { reconcile = next }, snapshot: (next: typeof snapshot) => { snapshot = next } }
}

it('removes the top task UI and keeps recovery available with no messages or trace', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: '继续任务', exact: true })
  expect(screen.queryByRole('button', { name: '任务状态' })).toBeNull()
  expect(f.container.querySelector('.run-panel')).toBeNull()
  expect(f.container.querySelector('.messages')?.contains(screen.getByRole('region', { name: '任务恢复' }))).toBe(true)
  await waitFor(() => expect(f.router.state.location.search).toBe(''))
})

it('keeps Lane history and places exactly one recovery card directly after its trace', async () => {
  const f = fixture({ messages: true })
  const card = await screen.findByRole('region', { name: '任务恢复' })
  await waitFor(() => expect(f.container.querySelector('.run-trace')?.nextElementSibling).toBe(card))
  expect(screen.getAllByRole('region', { name: '任务恢复' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /主进程/ }))
  expect(screen.getByText('主任务')).toBeTruthy()
  expect(screen.getByText('已有任务记录')).toBeTruthy()
})

it.each([{ snapshotFailure: true }, { messages: true, traceFailure: true }])('retains a safe recovery fallback when loading fails: %j', async options => {
  fixture(options)
  await screen.findByRole('button', { name: '继续任务', exact: true })
  if (options.snapshotFailure) {
    expect(screen.getByText('运行状态暂时无法确认')).toBeTruthy()
    expect(screen.queryByText('任务已中断，没有自动恢复')).toBeNull()
  }
})

it.each([409, 503, 410])('handles resume status %s without losing history or creating extra requests', async status => {
  const f = fixture({ messages: true })
  f.resume(async () => response({ error: 'NOT_AVAILABLE' }, status))
  fireEvent.click(await screen.findByRole('button', { name: '继续任务', exact: true }))
  await waitFor(() => expect(f.mutations).toEqual(['resume']))
  if (status === 410) await waitFor(() => expect(screen.queryByRole('region', { name: '任务恢复' })).toBeNull())
  else await waitFor(() => expect(screen.getByRole('button', { name: '继续任务', exact: true }).hasAttribute('disabled')).toBe(false))
  expect(screen.getByText('已有任务记录')).toBeTruthy()
})

it('locks both actions while the end confirmation is open, cancels safely, and ends after confirmation', async () => {
  const f = fixture({ messages: true })
  const end = await screen.findByRole('button', { name: '结束本轮' })
  fireEvent.click(end)
  await screen.findByRole('button', { name: '确认', exact: true })
  expect(screen.getByRole('button', { name: '继续任务', exact: true }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(end)
  expect(f.mutations).toEqual([])
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }))
  await waitFor(() => expect(end.hasAttribute('disabled')).toBe(false))
  expect(f.mutations).toEqual([])
  fireEvent.click(end)
  fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
  await waitFor(() => expect(f.mutations).toEqual(['end']))
  await waitFor(() => expect(screen.queryByRole('region', { name: '任务恢复' })).toBeNull())
  expect(screen.getByText('已有任务记录')).toBeTruthy()
})

it('preserves the card when ending fails and permits retry', async () => {
  const f = fixture()
  f.end(async () => response({ error: 'OFFLINE' }, 503))
  fireEvent.click(await screen.findByRole('button', { name: '结束本轮' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
  await waitFor(() => expect(f.mutations).toEqual(['end']))
  await waitFor(() => expect(screen.getByRole('button', { name: '结束本轮' }).hasAttribute('disabled')).toBe(false))
})

it.each(['running', 'succeeded', 'failed', 'cancelled'])('does not offer recovery for a %s snapshot', async state => {
  const f = fixture({ messages: true, state })
  await screen.findByText('已有任务记录')
  await waitFor(() => expect(f.container.querySelector('.run-trace')).toBeTruthy())
  expect(screen.queryByRole('region', { name: '任务恢复' })).toBeNull()
  expect(screen.queryByRole('button', { name: '任务状态' })).toBeNull()
})

it('does not start an old run or replace the current conversation when resume completes late', async () => {
  const f = fixture()
  let release!: (response: Response) => void
  f.resume(() => new Promise(resolve => { release = resolve }))
  fireEvent.click(await screen.findByRole('button', { name: '继续任务', exact: true }))
  await waitFor(() => expect(f.mutations).toEqual(['resume']))
  await act(async () => { await f.router.navigate('/work/pulse-chat') })
  await screen.findByText('消息：pulse-chat')
  await act(async () => { release(response({ runId: 'run-late' })) })
  expect(screen.getByText('消息：pulse-chat')).toBeTruthy()
  expect(screen.queryByRole('region', { name: '任务恢复' })).toBeNull()
  expect(f.subscriptions.some(path => path.includes('run-late'))).toBe(false)
})

it('ignores a delayed snapshot after navigating to a different conversation', async () => {
  const f = fixture()
  let release!: (response: Response) => void
  f.snapshot(() => new Promise(resolve => { release = resolve }))
  await waitFor(() => expect(release).toBeDefined())
  await act(async () => { await f.router.navigate('/work/pulse-chat') })
  await screen.findByText('消息：pulse-chat')
  await act(async () => { release(response({ runId: 'run-busy', state: 'interrupted', seq: 0, activities: [] })) })
  expect(screen.queryByRole('region', { name: '任务恢复' })).toBeNull()
  expect(screen.getByText('消息：pulse-chat')).toBeTruthy()
})

it('keeps the inline card and both buttons visible but disabled while resuming once', async () => {
  const f = fixture()
  let release!: (response: Response) => void
  f.resume(() => new Promise(resolve => { release = resolve }))
  const resume = await screen.findByRole('button', { name: '继续任务', exact: true })
  fireEvent.click(resume); fireEvent.click(resume)
  await waitFor(() => expect(f.mutations).toEqual(['resume']))
  expect(screen.getByRole('button', { name: '正在继续…' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '结束本轮' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { release(response({ runId: 'run-next' })) })
  await waitFor(() => expect(screen.queryByRole('region', { name: '任务恢复' })).toBeNull())
  await waitFor(() => expect(f.subscriptions).toContain('/api/runs/run-next/events?after=0'))
})
