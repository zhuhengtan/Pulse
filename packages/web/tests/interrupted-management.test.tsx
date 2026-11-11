import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PulseApp } from './RouterApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { sidebarFixture } from './fixtures/sidebar.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

async function show(state: 'interrupted' | 'running' | 'unknown' = 'interrupted', holdResume = false) {
  const f = sidebarFixture(), deletions: string[] = []
  let finishResume: (() => void) | undefined
  const transport: PulseWebTransport = { ...f.transport, request: async (path, init) => {
    if (path === '/api/runs/run-busy/state') return Response.json({ runId: 'run-busy', state: state === 'unknown' ? 'interrupted' : state, seq: 0, activities: [] }, { status: state === 'unknown' ? 503 : 200 })
    if (path === '/api/runs/run-busy/trace') return Response.json({ events: [], seq: 0 })
    if (holdResume && path.endsWith('/runs/run-busy/resume')) return new Promise<Response>(resolve => { finishResume = () => resolve(Response.json({ error: 'FIXTURE_OFFLINE' }, { status: 503 })) })
    if (path === '/api/conversations/busy' && init?.method === 'DELETE') { deletions.push(path); return Response.json({ ok: true }) }
    return f.transport.request(path, init)
  } }
  render(<PulseDesignSystem><PulseApp transport={transport}/></PulseDesignSystem>)
  fireEvent.click(await screen.findByRole('tab', { name: '工作' }))
  fireEvent.click(await screen.findByRole('button', { name: /^正在执行的任务/ }))
  if (state === 'interrupted') await screen.findByRole('status', { name: '任务已中断，没有自动恢复' })
  return { ...f, deletions, finishResume: () => finishResume?.() }
}

it('adds a process icon and enables archiving an interrupted conversation from More and the sidebar', async () => {
  const f = await show()
  expect(screen.getByRole('button', { name: '归档对话：正在执行的任务' })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: '更多', exact: true }))
  const processes = await screen.findByRole('menuitem', { name: '任务进程' })
  expect(processes.querySelector('svg')).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: '归档对话', exact: true }))
  await waitFor(() => expect(f.patches).toContainEqual({ id: 'busy', body: { archived: true } }))
  expect(screen.queryByRole('button', { name: /^正在执行的任务/ })).toBeNull()
  expect(f.deletions).toEqual([])
})

it('deletes an interrupted conversation only after confirmation', async () => {
  const f = await show()
  fireEvent.click(screen.getByRole('button', { name: '更多', exact: true }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除对话', exact: true }))
  expect(f.deletions).toEqual([])
  fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
  await waitFor(() => expect(f.deletions).toEqual(['/api/conversations/busy']))
})

it.each(['running', 'unknown'] as const)('keeps archive/delete disabled when a run is %s', async state => {
  await show(state)
  expect(screen.getByRole('button', { name: '归档对话：正在执行的任务' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '更多', exact: true }))
  expect((await screen.findByRole('menuitem', { name: '归档对话', exact: true })).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('menuitem', { name: '删除对话', exact: true }).getAttribute('aria-disabled')).toBe('true')
})

it('blocks archive/delete while an interrupted task is being resumed', async () => {
  const f = await show('interrupted', true)
  fireEvent.click(screen.getByRole('button', { name: '继续任务', exact: true }))
  expect(await screen.findByRole('button', { name: '正在继续…', exact: true })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '更多', exact: true }))
  expect((await screen.findByRole('menuitem', { name: '归档对话', exact: true })).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('menuitem', { name: '删除对话', exact: true }).getAttribute('aria-disabled')).toBe('true')
  f.finishResume()
  await waitFor(() => expect(screen.getByRole('button', { name: '继续任务', exact: true })).toHaveProperty('disabled', false))
})

async function closed(state: 'interrupted' | 'running' | 'failed') {
  const f = sidebarFixture(), deletions: string[] = []
  const transport: PulseWebTransport = { ...f.transport, request: async (path, init) => {
    if (path === '/api/runs/run-busy/state') return state === 'failed' ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ runId: 'run-busy', state, seq: 0, activities: [] })
    if (path === '/api/conversations/busy' && init?.method === 'DELETE') { deletions.push(path); return Response.json({ ok: true }) }
    return f.transport.request(path, init)
  } }
  render(<PulseDesignSystem><PulseApp transport={transport}/></PulseDesignSystem>)
  fireEvent.click(await screen.findByRole('tab', { name: '工作' }))
  return { ...f, deletions }
}

it('archives an unopened interrupted conversation after the server confirms it', async () => {
  const f = await closed('interrupted')
  expect(screen.queryByRole('status', { name: '任务已中断，没有自动恢复' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: '归档对话：正在执行的任务', hidden: true }))
  await waitFor(() => expect(f.patches).toContainEqual({ id: 'busy', body: { archived: true } }))
})

it('deletes an unopened interrupted conversation after the server confirms it', async () => {
  const f = await closed('interrupted')
  fireEvent.click(await screen.findByRole('button', { name: '对话操作：正在执行的任务', hidden: true }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
  await waitFor(() => expect(f.deletions).toEqual(['/api/conversations/busy']))
})

it.each(['running', 'failed'] as const)('does not archive or delete an unopened conversation when its state is %s', async state => {
  const f = await closed(state)
  fireEvent.click(await screen.findByRole('button', { name: '归档对话：正在执行的任务', hidden: true }))
  expect(await screen.findByText('任务仍在运行或状态待确认，暂时不能归档。')).toBeTruthy()
  expect(f.patches).toEqual([])
  fireEvent.click(await screen.findByRole('button', { name: '对话操作：正在执行的任务', hidden: true }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除', exact: true }))
  expect(await screen.findByText('任务仍在运行或状态待确认，暂时不能删除。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '确认', exact: true })).toBeNull()
})

it('keeps an unopened conversation when the server rejects a stale idle confirmation', async () => {
  const f = await closed('interrupted')
  f.rejectMove()
  fireEvent.click(await screen.findByRole('button', { name: '归档对话：正在执行的任务', hidden: true }))
  expect(await screen.findByText('任务仍在运行，暂时不能归档。')).toBeTruthy()
  expect(screen.getByRole('button', { name: /^正在执行的任务/ })).toBeTruthy()
})
