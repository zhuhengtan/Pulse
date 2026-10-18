import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyTrace, PersistedRunTrace, reduceTrace, RunTraceView } from '../src/RunTrace.js'
import { PulseApp } from './RouterApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { PulseWebTransport, WebRunEvent } from '../src/transport.js'
import { sidebarFixture } from './fixtures/sidebar.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => window.localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function model(seq: number, modelId: string, attemptNo: number): WebRunEvent {
  return { type: 'trace', runId: 'run-busy', seq, data: { kind: 'model', effectId: 'llm', laneId: 'root', attemptId: `a${attemptNo}`, attemptNo, task: 'reason', modelId, fallback: attemptNo > 1 } }
}
function reasoning(seq: number, text: string, attemptNo = 1): WebRunEvent {
  return { type: 'trace', runId: 'run-busy', seq, data: { kind: 'reasoning', effectId: 'llm', laneId: 'root', attemptId: `a${attemptNo}`, task: 'reason', text } }
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

describe('execution trace replay', () => {
  it('keeps failed and fallback attempts separate, including notes and unnumbered prose', () => {
    const state = [model(1, 'A', 1), reasoning(2, 'A thought'), model(3, 'B', 2), reasoning(4, 'B thought', 2), { ...reasoning(5, 'B note', 2), data: { ...reasoning(5, 'B note', 2).data, kind: 'note' } } as WebRunEvent].reduce(reduceTrace, emptyTrace)
    expect(state.lanes.root?.steps).toMatchObject([
      { modelId: 'A', attemptId: 'a1', attemptNo: 1, reasoning: 'A thought', fallback: false },
      { modelId: 'B', attemptId: 'a2', attemptNo: 2, reasoning: 'B thought', note: 'B note', fallback: true },
    ])
  })

  it('stops appending reasoning once the visible thought reaches its cap', () => {
    const state = [model(1, 'A', 1), reasoning(2, 'A'.repeat(24_000)), reasoning(3, 'B'.repeat(10_000))].reduce(reduceTrace, emptyTrace)
    expect(state.lanes.root?.steps[0]?.reasoning).toBe('A'.repeat(24_000))
  })

  it.each(['succeeded', 'failed', 'cancelled'] as const)('collapses a %s run while retaining the header and allowing manual replay', outcome => {
    const trace = [model(1, 'A', 1), reasoning(2, '保持展开')].reduce(reduceTrace, emptyTrace)
    const view = render(<RunTraceView trace={trace} running />)
    expect(screen.getByText('保持展开')).toBeTruthy()
    // An explicit expansion during execution must also collapse on completion.
    const head = screen.getByRole('button', { name: /主进程/ })
    fireEvent.click(head)
    fireEvent.click(head)
    view.rerender(<RunTraceView trace={{ ...trace, outcome }} running={false} />)
    expect(screen.queryByText('保持展开')).toBeNull()
    expect(head.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(head)
    fireEvent.click(screen.getByRole('button', { name: /思考 ·/ }))
    expect(screen.getByText('保持展开')).toBeTruthy()
    expect(screen.getByRole('region', { name: '执行过程' }).tabIndex).toBe(0)
    view.rerender(<RunTraceView trace={{ ...trace, outcome, endedAt: 9000 }} running={false} />)
    expect(screen.getByText('保持展开')).toBeTruthy()
    view.unmount()
    render(<RunTraceView trace={trace} running={false} />)
    expect(screen.queryByText('保持展开')).toBeNull()
  })

  it('keeps an empty completed process visible and collapsed', () => {
    const view = render(<RunTraceView trace={emptyTrace} running />)
    view.rerender(<RunTraceView trace={{ ...emptyTrace, outcome: 'succeeded' }} running={false} />)
    expect(screen.getByRole('button', { name: /主进程.*已完成/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('collapses when completion arrives before stream cleanup, without collapsing a manual replay again', () => {
    const trace = [model(1, 'A', 1), reasoning(2, '原始思考')].reduce(reduceTrace, emptyTrace)
    const view = render(<RunTraceView trace={trace} running />)
    const finished = { ...trace, outcome: 'succeeded' as const }
    view.rerender(<RunTraceView trace={finished} running />)
    const head = screen.getByRole('button', { name: /主进程.*已完成/ })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(head)
    view.rerender(<RunTraceView trace={finished} running={false} />)
    expect(head.getAttribute('aria-expanded')).toBe('true')
  })

  it('uses saved event times when reopened and omits invented durations for legacy records', async () => {
    const events: WebRunEvent[] = [
      { ...model(1, 'A', 1), runStartedAt: 1_000, timestamp: 5_000 },
      { type: 'complete', runId: 'run-busy', seq: 2, runStartedAt: 1_000, timestamp: 91_000, data: { status: 'succeeded' } },
    ]
    const transport: PulseWebTransport = { request: async () => response({ events }), subscribe: () => () => {} }
    vi.spyOn(Date, 'now').mockReturnValue(999_000)
    const view = render(<PersistedRunTrace runId="run-busy" transport={transport} />)
    await screen.findByText(/耗时 90s/)
    view.unmount()
    const legacyTransport: PulseWebTransport = { ...transport, request: async () => response({ events: events.map(({ timestamp: _timestamp, runStartedAt: _start, ...event }) => event) }) }
    render(<PersistedRunTrace runId="run-busy" transport={legacyTransport} />)
    await screen.findByText(/已完成 · 1 个 Lane/)
    expect(screen.queryByText(/耗时/)).toBeNull()
  })
})

function workFixture(traceResponse: () => Promise<Response>) {
  const base = sidebarFixture().transport
  let receive: ((event: WebRunEvent) => void) | undefined
  const subscriptions: string[] = []
  const transport: PulseWebTransport = {
    async request(path, init) {
      if (path === '/api/runs/run-busy/state') return response({ runId: 'run-busy', state: 'running', seq: 2, activities: [] })
      if (path === '/api/runs/run-busy/trace') return traceResponse()
      if (path === '/api/web/conversations/busy/messages') return response([{ id: 'user', role: 'user', text: '请继续处理', runId: 'run-busy', createdAt: new Date().toISOString() }])
      return base.request(path, init)
    },
    subscribe(path, onEvent) { subscriptions.push(path); receive = onEvent; return () => { receive = undefined } },
  }
  return { transport, subscriptions, emit: (event: WebRunEvent) => { if (!receive) throw new Error('NOT_SUBSCRIBED'); receive(event) } }
}

async function openWork(transport: PulseWebTransport) {
  render(<PulseDesignSystem><PulseApp transport={transport} /></PulseDesignSystem>)
  await screen.findByText('我们要做什么？')
  fireEvent.click(screen.getByRole('tab', { name: '工作' }))
  fireEvent.click(await screen.findByRole('button', { name: /^正在执行的任务/ }))
}

describe('active work trace recovery', () => {
  it('hydrates the prefix and appends later SSE events once, even when the trace is newer than the state snapshot', async () => {
    const fixture = workFixture(async () => response({ events: [model(1, 'A', 1), reasoning(2, '历史思考'), reasoning(3, '加载期间思考')], seq: 3 }))
    await openWork(fixture.transport)
    await waitFor(() => expect(fixture.subscriptions).toEqual(['/api/runs/run-busy/events?after=2']))
    await screen.findByText('历史思考加载期间思考')
    act(() => { fixture.emit(reasoning(3, '加载期间思考')); fixture.emit(reasoning(4, '后续思考')) })
    await screen.findByText('历史思考加载期间思考后续思考')
    expect(screen.queryByText('历史思考加载期间思考加载期间思考后续思考')).toBeNull()
    // Reopening an active conversation must hydrate the prefix again.
    fireEvent.click(screen.getByRole('button', { name: '完善项目记忆' }))
    await screen.findByText('对话内容会保留，所属项目可以随时调整。')
    fireEvent.click(screen.getByRole('button', { name: /^正在执行的任务/ }))
    await screen.findByText('历史思考加载期间思考')
    expect(fixture.subscriptions).toHaveLength(2)
  })

  it('replays from zero if trace loading fails instead of dropping the prefix', async () => {
    const fixture = workFixture(async () => response({ error: 'TEMPORARILY_UNAVAILABLE' }, 503))
    await openWork(fixture.transport)
    await waitFor(() => expect(fixture.subscriptions).toEqual(['/api/runs/run-busy/events?after=0']))
    act(() => { fixture.emit(model(1, 'A', 1)); fixture.emit(reasoning(2, '恢复完整思考')) })
    await screen.findByText('恢复完整思考')
  })

  it('does not restore snapshot-covered approvals when trace loading replays the stream', async () => {
    const fixture = workFixture(async () => response({ error: 'TEMPORARILY_UNAVAILABLE' }, 503))
    await openWork(fixture.transport)
    await waitFor(() => expect(fixture.subscriptions).toEqual(['/api/runs/run-busy/events?after=0']))
    const approval = (seq: number, prompt: string): WebRunEvent => ({ type: 'interactions', runId: 'run-busy', seq, data: { interactions: [{ groupId: `g${seq}`, kind: 'approval', items: [{ effectId: `e${seq}`, input: { prompt } }] }] } })
    act(() => { fixture.emit(approval(1, '旧审批不应出现')); fixture.emit(approval(4, '新审批')) })
    await screen.findByText('新审批')
    expect(screen.queryByText('旧审批不应出现')).toBeNull()
  })

  it('ignores a late trace response after the user switches conversations', async () => {
    let resolve!: (response: Response) => void
    const fixture = workFixture(() => new Promise<Response>(done => { resolve = done }))
    await openWork(fixture.transport)
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('button', { name: '完善项目记忆' }))
    await act(async () => { resolve(response({ events: [model(1, 'A', 1), reasoning(2, '不应串入其他会话')], seq: 2 })) })
    expect(fixture.subscriptions).toEqual([])
    expect(screen.queryByText('不应串入其他会话')).toBeNull()
  })
})
