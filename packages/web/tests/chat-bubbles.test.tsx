import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Editor } from '@tiptap/core'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { followupFixture } from './fixtures/followup.js'
beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Range.prototype.getClientRects = () => [] as any
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, toJSON() {} })
})
afterEach(() => { cleanup(); localStorage.clear() })
it('keeps chat to bubbles and one typing indicator, hides intermediate output and sends supplements immediately', async () => {
  const fixture = followupFixture('chat')
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: ['/chat'] })
  const ui = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  await ui.findByText('正在执行的原始任务')
  expect(ui.getAllByLabelText('Pulse 正在输入')).toHaveLength(1)
  const listeners = fixture.subscriptions.get('run-fixture-initial')!
  act(() => listeners.forEach(emit => {
    emit({ type: 'trace', runId: 'run-fixture-initial', seq: 1, data: { kind: 'reasoning', task: 'reason', text: '内部思考不应出现' } })
    emit({ type: 'text', runId: 'run-fixture-initial', seq: 2, data: '未定稿的正文' })
  }))
  expect(ui.queryByText('内部思考不应出现')).toBeNull()
  expect(ui.queryByText('未定稿的正文')).toBeNull()
  expect(ui.queryByLabelText('待发消息队列')).toBeNull()
  expect(ui.queryByRole('button', { name: /审核模式/ })).toBeNull()
  const editor = (ui.container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
  act(() => editor.commands.setContent('再补充一点'))
  expect(ui.queryByLabelText('发送方式')).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: '发送', exact: true }))
  await waitFor(() => expect(fixture.calls.some(call => call.path === '/api/assistant/messages' && call.body.delivery === 'immediate')).toBe(true))
  expect(ui.getAllByLabelText('Pulse 正在输入')).toHaveLength(1)
  act(() => fixture.finish())
  await waitFor(() => expect(ui.queryByLabelText('Pulse 正在输入')).toBeNull())
})
