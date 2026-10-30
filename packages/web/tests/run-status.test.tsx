import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PulseApp } from './RouterApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { compactRunLabel, missingCompleteStatus } from '../src/run-status.js'
import type { PulseWebTransport, WebRunEvent } from '../src/transport.js'
import { sidebarFixture } from './fixtures/sidebar.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => window.localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

describe('compact run status', () => {
  it('labels a terminal snapshot without completion conservatively', () => {
    expect(missingCompleteStatus('running')).toBeUndefined()
    expect(missingCompleteStatus('interrupted')?.label).toBe('任务已中断，没有自动恢复')
    expect(missingCompleteStatus('succeeded')?.label).toBe('运行已结束，验收状态未知')
    expect(missingCompleteStatus('failed')?.label).toBe('任务执行失败')
    expect(missingCompleteStatus('cancelled')?.label).toBe('任务已取消')
    expect(compactRunLabel({ running: true, interaction: 'ask', steps: [] })).toBe('等待你的回答')
    expect(compactRunLabel({ running: true, interaction: 'approval', steps: [] })).toBe('等待审批')
    expect(compactRunLabel({ running: true, steps: [], latestToolPending: true })).toBe('等待进程')
    expect(compactRunLabel({ running: true, steps: [{ kind: 'tool', tool: 'shell.poll', status: 'succeeded', preview: { status: 'running' } }, { kind: 'tool', tool: 'fs.read', status: 'running' }], latestToolPending: true })).toBe('执行中')
    expect(compactRunLabel({ running: false, completeLabel: '任务未完成', steps: [{ kind: 'tool', tool: 'shell.poll', status: 'succeeded', preview: { status: 'running' } }] })).toBe('任务未完成')
  })

  it('keeps the connection mark independent of a recovered task status', async () => {
    const base = sidebarFixture().transport
    const transport: PulseWebTransport = {
      async request(path, init) {
        if (path === '/api/session/local' || path === '/api/session') return response({ localAdmin: true, canUseTerminal: false, connected: false })
        if (path === '/api/runs/run-busy/state') return response({ runId: 'run-busy', state: 'succeeded', seq: 1, activities: [] })
        if (path === '/api/runs/run-busy/trace') return response({ events: [], seq: 1 })
        if (path === '/api/web/conversations/busy/messages') return response([])
        return base.request(path, init)
      },
      subscribe: () => () => {},
    }
    render(<PulseDesignSystem><PulseApp transport={transport} /></PulseDesignSystem>)
    expect(await screen.findByRole('status', { name: '服务未连接' })).toBeTruthy()
    expect(screen.getByTitle('Pulse 助理').textContent).toBe('Pulse 助理')
    fireEvent.click(screen.getByRole('tab', { name: '工作' }))
    fireEvent.click(await screen.findByRole('button', { name: /^正在执行的任务/ }))
    expect(await screen.findByRole('status', { name: '运行已结束，验收状态未知' })).toBeTruthy()
    expect(screen.getByRole('status', { name: '服务未连接' })).toBeTruthy()
    expect(screen.getByTitle('正在执行的任务').textContent).toBe('正在执行的任务')
  })

  it('shows a recovered running process, then replaces it with later work and completion', async () => {
    const base = sidebarFixture().transport
    let receive: ((event: WebRunEvent) => void) | undefined
    const shell: WebRunEvent = { type: 'tool', runId: 'run-busy', seq: 1, data: { activityId: 'process', effectId: 'process', tool: 'shell.poll', status: 'succeeded', preview: { status: 'running' } } }
    const transport: PulseWebTransport = {
      async request(path, init) {
        if (path === '/api/session/local' || path === '/api/session') return response({ localAdmin: true, canUseTerminal: false, connected: true })
        if (path === '/api/runs/run-busy/state') return response({ runId: 'run-busy', state: 'running', seq: 1, activities: [shell] })
        if (path === '/api/runs/run-busy/trace') return response({ events: [shell], seq: 1 })
        if (path === '/api/web/conversations/busy/messages') return response([])
        return base.request(path, init)
      },
      subscribe(_path, onEvent) { receive = onEvent; return () => { receive = undefined } },
    }
    render(<PulseDesignSystem><PulseApp transport={transport} /></PulseDesignSystem>)
    await screen.findByText('我们要做什么？')
    expect(screen.getByRole('status', { name: '服务已连接' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '工作' }))
    fireEvent.click(await screen.findByRole('button', { name: /^正在执行的任务/ }))
    expect(await screen.findByRole('status', { name: '等待进程' })).toBeTruthy()
    await waitFor(() => expect(receive).toBeTypeOf('function'))
    act(() => receive?.({ type: 'tool', runId: 'run-busy', seq: 2, data: { activityId: 'read', effectId: 'read', tool: 'fs.read', status: 'running' } }))
    expect(await screen.findByRole('status', { name: '执行中' })).toBeTruthy()
    act(() => receive?.({ type: 'complete', runId: 'run-busy', seq: 3, data: { status: 'succeeded', taskRequired: true, taskOutcome: { status: 'incomplete' } } }))
    expect(await screen.findByRole('status', { name: '任务未完成' })).toBeTruthy()
    expect(screen.getByRole('status', { name: '服务已连接' })).toBeTruthy()
    expect(screen.getByTitle('正在执行的任务').textContent).toBe('正在执行的任务')
  })
})
