import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { WebRunEvent } from '../src/transport.js'
import { followupFixture } from './fixtures/followup.js'

beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Range.prototype.getClientRects = () => [] as any
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, toJSON() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

function approvalFixture() {
  const fixture = followupFixture('chat'), request = fixture.transport.request
  const callbacks: Array<{ event: (event: WebRunEvent) => void; error: () => void; close: ReturnType<typeof vi.fn> }> = []
  const subscribe = fixture.transport.subscribeChat!
  fixture.transport.subscribeChat = (id, after, event, error) => {
    const unsubscribe = subscribe(id, after, event, error), close = vi.fn(unsubscribe)
    callbacks.push({ event, error, close })
    return close
  }
  fixture.messages.push({ id: 'approval-notice', role: 'assistant', text: '需要写入报告，请确认。', runId: 'run-callback', createdAt: new Date().toISOString(), messageKind: 'work_notice', workAction: {
    callbackId: 'callback-approval', conversationId: 'work', runId: 'run-work', controlRevision: 3, fingerprint: 'operation-hash',
    interaction: { groupId: 'approval-group', kind: 'approval', items: [{ effectId: 'write-report', input: { tools: [{ toolName: 'fs.write', details: { path: 'report.txt' } }] } }] },
  } })
  let onApproval = () => {}
  const approvals: unknown[] = []
  fixture.transport.request = (path, init) => {
    if (path === '/api/assistant/work/work/replies') {
      approvals.push(JSON.parse(String(init?.body)))
      onApproval()
      return Promise.resolve(Response.json({ ok: true }))
    }
    return request(path, init)
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: ['/chat'] })
  const ui = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  return { ...fixture, ui, callbacks, approvals, onApproval: (callback: () => void) => { onApproval = callback } }
}

it('does not append an interrupted reply when approving work after a finished chat stream sends late callbacks', async () => {
  const f = approvalFixture()
  await f.ui.findByText('正在执行的原始任务')
  await waitFor(() => expect(f.callbacks).toHaveLength(1))
  act(() => f.finish())
  await waitFor(() => expect(f.callbacks[0]!.close).toHaveBeenCalled())
  f.onApproval(() => {
    f.callbacks[0]!.error()
    f.callbacks[0]!.event({ type: 'resync', runId: 'run-fixture-initial', seq: 100, data: { runId: 'run-fixture-initial', state: 'interrupted', seq: 100, activities: [] } })
  })
  fireEvent.click(f.ui.getByRole('button', { name: '同意', exact: true }))
  await f.ui.findByText('此事项已处理')
  expect(f.approvals).toEqual([{ callbackId: 'callback-approval', fingerprint: 'operation-hash', answers: [{ effectId: 'write-report', value: { approved: true } }] }])
  expect(f.ui.queryByText('回复中断了，可以重新发送。')).toBeNull()
  expect(f.ui.queryByText('连接中断，正在尝试恢复…')).toBeNull()
  expect(f.calls).toHaveLength(0) // Approval must neither send chat input nor cancel work.
})

it('reconciles an interrupted snapshot with a subsequently completed chat receipt on approval refresh', async () => {
  const f = approvalFixture()
  await waitFor(() => expect(f.callbacks).toHaveLength(1))
  act(() => f.callbacks[0]!.event({ type: 'resync', runId: 'run-fixture-initial', seq: 100, data: { runId: 'run-fixture-initial', state: 'interrupted', seq: 100, activities: [] } }))
  await f.ui.findByText('回复中断了，可以重新发送。')
  // The durable receipt now confirms success; the old stream's complete/finish
  // events were missed. Approval changes cause the ordinary assistant refresh.
  f.onApproval(() => f.finish())
  fireEvent.click(f.ui.getByRole('button', { name: '同意', exact: true }))
  await f.ui.findByText('此事项已处理')
  await waitFor(() => expect(f.ui.queryByText('回复中断了，可以重新发送。')).toBeNull())
})

it('keeps real active disconnects and failed replies visible while work approvals remain independent', async () => {
  const f = approvalFixture()
  await waitFor(() => expect(f.callbacks).toHaveLength(1))
  act(() => f.callbacks[0]!.error())
  await f.ui.findByText('连接中断，正在尝试恢复…')
  act(() => f.finish('failed'))
  await f.ui.findByText('这次没能完成回复，请重试。')
  fireEvent.click(f.ui.getByRole('button', { name: '同意', exact: true }))
  await f.ui.findByText('此事项已处理')
  expect(f.ui.getByText('这次没能完成回复，请重试。')).toBeTruthy()
  expect(f.approvals).toHaveLength(1)
  expect(f.calls).toHaveLength(0)
})
