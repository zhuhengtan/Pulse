import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { WebMessage, WebRunEvent } from '../src/transport.js'
import { followupFixture } from './fixtures/followup.js'

beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
const routers: ReturnType<typeof createMemoryRouter>[] = []
afterEach(() => { cleanup(); routers.splice(0).forEach(router => router.dispose()); localStorage.clear(); vi.restoreAllMocks() })

async function open(surface: 'chat' | 'work', records: WebMessage[]) {
  const fixture = followupFixture(surface), original = fixture.transport.request
  const runId = fixture.conversation.activeRunId!
  const changes = new Set<() => void>()
  fixture.transport.onChange = listener => { changes.add(listener); return () => { changes.delete(listener) } }
  fixture.transport.request = async (path, init) => {
    const response = await original(path, init)
    if (path === '/api/assistant' && surface === 'chat') {
      const view = await response.json()
      return Response.json({ ...view, messages: [...view.messages, ...records] })
    }
    if (path === '/api/web/conversations/busy/messages') return Response.json([...(await response.json()), ...records])
    return response
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: [surface === 'chat' ? '/chat' : '/work/busy'] })
  routers.push(router)
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  await view.findByText('正在执行的原始任务')
  await waitFor(() => expect(fixture.subscriptions.get(runId)?.size).toBe(1))
  let sequence = 0
  return { view, notify: () => changes.forEach(listener => listener()), emit: (text: string) => {
    const event: WebRunEvent = { type: 'text', runId, seq: ++sequence, data: text }
    fixture.subscriptions.get(runId)?.forEach(listener => listener(event))
  } }
}
const answer = (patch: Partial<WebMessage> = {}): WebMessage => ({ id: 'msg-saved-answer', role: 'assistant', runId: 'run-fixture-initial', text: 'Desktop socket reply', createdAt: '2026-10-28T00:00:00Z', restored: true, ...patch })

it.each(['chat', 'work'] as const)('renders one %s reply when the saved answer arrives before its text event', async surface => {
  const { view, emit } = await open(surface, [answer()])
  await view.findByText('已从归档恢复答案')
  act(() => emit('Desktop socket reply'))
  expect(view.getAllByText('Desktop socket reply', { exact: true })).toHaveLength(1)
  expect(view.getByText('已从归档恢复答案')).toBeTruthy()
})

it('replaces a streamed reply with its canonical record when local data changes', async () => {
  const records: WebMessage[] = []
  const { view, emit, notify } = await open('chat', records)
  act(() => emit('Desktop socket reply'))
  expect(view.getAllByText('Desktop socket reply', { exact: true })).toHaveLength(1)
  records.push(answer())
  act(notify)
  await view.findByText('已从归档恢复答案')
  expect(view.getAllByText('Desktop socket reply', { exact: true })).toHaveLength(1)
})

it.each(['ask-question-fixture', 'input-response-fixture', 'plan-preview-fixture'])('retains %s separately from the final reply', async id => {
  const { view, emit } = await open('chat', [answer({ id })])
  act(() => emit('Desktop socket reply'))
  expect(view.getAllByText('Desktop socket reply', { exact: true })).toHaveLength(2)
})

it('retains identical replies from different runs and distinct child replies in one run', async () => {
  const { view, emit } = await open('chat', [answer({ runId: 'older-run' }), answer({ id: 'msg-child-answer', text: 'Independent child answer' })])
  act(() => emit('Desktop socket reply'))
  expect(view.getAllByText('Desktop socket reply', { exact: true })).toHaveLength(2)
  expect(view.getByText('Independent child answer')).toBeTruthy()
})
