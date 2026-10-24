import { useState } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { RichComposer, emptyComposerDraft } from '../src/RichComposer.js'
import { ChatSurface, deriveChatState } from '../src/ChatSurface.js'
import { InteractionPanel, type PendingInteraction } from '../src/InteractionPanel.js'
import { MessageQueuePanel } from '../src/MessageQueuePanel.js'
import type { ConversationQueue, MessageQueueController } from '../src/MessageQueue.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { PulseApp } from '../src/PulseApp.js'
import { followupFixture } from './fixtures/followup.js'

beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON() {} })
})
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })
const transport = { request: async () => Response.json({ skills: [], paths: [] }), subscribe: () => () => {} }
const editorOf = (view: ReturnType<typeof render>) => (view.container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
function Composer({ running = true, stopping = false, send = vi.fn(async () => true), behavior = 'queue' }: { running?: boolean; stopping?: boolean; send?: ReturnType<typeof vi.fn>; behavior?: 'queue' | 'immediate' }) {
  const [draft, setDraft] = useState(emptyComposerDraft)
  return <PulseDesignSystem><ChatSurface><RichComposer draft={draft} onChange={setDraft} transport={transport} surfaceMode="work" running={running} stopping={stopping} followupBehavior={behavior} onSend={send}/></ChatSurface></PulseDesignSystem>
}
it.each(['queue', 'immediate'] as const)('sends the alternate busy behavior with Cmd/Ctrl Enter without changing %s preference', async behavior => {
  const send = vi.fn(async () => true), view = render(<Composer send={send} behavior={behavior}/>)
  act(() => editorOf(view).commands.setContent('补充上下文'))
  fireEvent.keyDown(view.container.querySelector('.tiptap')!, { key: 'Enter', ctrlKey: true })
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '补充上下文', richContent: expect.objectContaining({ version: 1 }) }), behavior === 'queue' ? 'immediate' : 'queue'))
  act(() => editorOf(view).commands.setContent('下一轮'))
  fireEvent.keyDown(view.container.querySelector('.tiptap')!, { key: 'Enter' })
  await waitFor(() => expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: '下一轮' }), behavior))
})
it('shows only stop for an empty busy draft and retains an editable draft while stopping', async () => {
  const send = vi.fn(async () => true), view = render(<Composer send={send}/>)
  expect(view.getByRole('button', { name: '停止生成' })).toBeTruthy()
  expect(view.queryByRole('button', { name: '加入队列' })).toBeNull()
  act(() => editorOf(view).commands.setContent('保留这条'))
  expect(view.getByRole('button', { name: '加入队列' })).toBeTruthy()
  view.rerender(<Composer send={send} stopping/>)
  expect(editorOf(view).isEditable).toBe(true)
  fireEvent.keyDown(view.container.querySelector('.tiptap')!, { key: 'Enter', metaKey: true })
  expect(send).not.toHaveBeenCalled()
  expect(editorOf(view).getText()).toBe('保留这条')
  expect((view.getByRole('button', { name: '加入队列' }) as HTMLButtonElement).disabled).toBe(true)
})
it('does not send an IME confirmation or Shift Enter', () => {
  const send = vi.fn(async () => true), view = render(<Composer send={send}/>)
  act(() => editorOf(view).commands.setContent('中文'))
  fireEvent.keyDown(view.container.querySelector('.tiptap')!, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(view.container.querySelector('.tiptap')!, { key: 'Enter', shiftKey: true })
  expect(send).not.toHaveBeenCalled()
})
it('the send menu delivers one immediate input without changing the default', async () => {
  const send = vi.fn(async () => true), view = render(<Composer send={send}/>)
  act(() => editorOf(view).commands.setContent('现在看看'))
  fireEvent.click(view.getByRole('button', { name: '发送方式' }))
  fireEvent.click(await view.findByRole('menuitem', { name: /立即发送/ }))
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '现在看看' }), 'immediate'))
  act(() => editorOf(view).commands.setContent('下一件事'))
  expect(view.getByRole('button', { name: '加入队列' })).toBeTruthy()
})
const approval: PendingInteraction = { kind: 'interaction', runId: 'approval-run', groupId: 'approval-group', interactionKind: 'approval', items: [{ effectId: 'effect', input: { prompt: '需要验证项目', tools: [{ toolName: 'shell.exec', details: { command: 'pnpm', args: ['test', '--filter', 'hello world'] } }] } }] }
it('renders complete command arguments and never duplicates stop or policy controls', async () => {
  const submit = vi.fn(async () => true)
  const view = render(<InteractionPanel interaction={approval} reviewNote="" delegated={false} submit={submit}/>)
  expect(view.getByText('pnpm "test" "--filter" "hello world"')).toBeTruthy()
  expect(view.queryByRole('button', { name: /停止|审核模式/ })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: '允许本次' }))
  await waitFor(() => expect(view.queryByRole('region', { name: '待审批操作' })).toBeNull())
  expect(submit).toHaveBeenCalledTimes(1)
})
it('keeps failed approval actionable and prevents duplicate submissions while pending', async () => {
  let reject!: (reason: Error) => void
  const submit = vi.fn(() => new Promise<boolean>((_, no) => { reject = no }))
  const view = render(<InteractionPanel interaction={approval} reviewNote="" delegated={false} submit={submit}/>)
  fireEvent.click(view.getByRole('button', { name: '允许本次' }))
  fireEvent.click(view.getByRole('button', { name: '拒绝' }))
  expect(submit).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error('offline')))
  expect(view.getByRole('alert').textContent).toContain('内容已保留')
  expect((view.getByRole('button', { name: '允许本次' }) as HTMLButtonElement).disabled).toBe(false)
})
it('shows the complete batch count and expandable operations across approval items', () => {
  const items = [1, 2].map(i => ({ effectId: `effect-${i}`, input: { operationCount: 1, tools: [{ toolName: 'fs.write', details: { path: `/tmp/file-${i}.txt` } }] } }))
  const view = render(<InteractionPanel interaction={{ ...approval, items }} reviewNote="" delegated={false} submit={async () => true}/>)
  expect(view.getByText('允许执行这 2 项操作？')).toBeTruthy()
  expect(view.getByText('查看全部 2 项操作')).toBeTruthy()
  expect(view.getByText('/tmp/file-1.txt')).toBeTruthy()
  expect(view.getByText('/tmp/file-2.txt')).toBeTruthy()
})
it('restores a single question draft and submits directly without a review page', async () => {
  const question: PendingInteraction = { ...approval, interactionKind: 'ask', items: [{ effectId: 'question', input: { type: 'input', prompt: '如何处理？' } }] }
  const submit = vi.fn(async () => true)
  localStorage.setItem('pulse-web-interaction:approval-run:approval-group', JSON.stringify({ question: { text: '原来的答案' } }))
  const view = render(<InteractionPanel interaction={question} reviewNote="" delegated={false} submit={submit}/>)
  expect((view.getByRole('textbox') as HTMLTextAreaElement).value).toBe('原来的答案')
  expect(view.queryByRole('button', { name: /上一题|检查答案/ })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith([{ effectId: 'question', value: { text: '原来的答案' } }]))
})
const queue: ConversationQueue = { key: 'queue', scope: 'fixture', conversationId: 'conversation', surface: 'work', paused: true, entries: Array.from({ length: 5 }, (_, i) => ({ requestId: `q${i}`, payload: { text: `待发 ${i}`, skills: ['keep'], mentionedFiles: ['keep.ts'] }, createdAt: new Date().toISOString() })) }
it('limits the queue to three rows and retains an unsaved edit when persistence fails', async () => {
  const edit = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined)
  const controller = { edit, pause: vi.fn(), remove: vi.fn(), sendNow: vi.fn() } as unknown as MessageQueueController
  const view = render(<PulseDesignSystem><ChatSurface><MessageQueuePanel queue={queue} controller={controller} onError={() => {}}/></ChatSurface></PulseDesignSystem>)
  expect(view.queryByText('待发 4')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /另有 2 条/ }))
  expect(view.container.querySelectorAll('.queue-row')).toHaveLength(5)
  fireEvent.click(view.getAllByRole('button', { name: '消息操作' })[0]!)
  fireEvent.click(await view.findByRole('menuitem', { name: '编辑' }))
  act(() => editorOf(view).commands.setContent('修改后'))
  fireEvent.click(view.getByRole('button', { name: '保存待发消息' }))
  await view.findByRole('alert')
  expect(editorOf(view).getText()).toBe('修改后')
  fireEvent.click(view.getByRole('button', { name: '保存待发消息' }))
  await waitFor(() => expect(view.queryByRole('textbox')).toBeNull())
  expect(edit).toHaveBeenLastCalledWith('conversation', 'q0', expect.objectContaining({ text: '修改后', richContent: expect.objectContaining({ version: 1 }) }))
})
it.each(['chat', 'work'] as const)('keeps %s stop pending until acknowledgement, allows retry and preserves the draft', async surface => {
  const fixture = followupFixture(surface), original = fixture.transport.request
  let attempts = 0, release!: () => void
  fixture.transport.request = async (path, init) => {
    if (path.endsWith('/cancel')) {
      attempts++
      if (attempts === 1) return Response.json({ error: 'OFFLINE' }, { status: 503 })
      await new Promise<void>(resolve => { release = resolve })
    }
    return original(path, init)
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: [surface === 'chat' ? '/chat' : '/work/busy'] })
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  try {
    await view.findByText('正在执行的原始任务')
    act(() => editorOf(view).commands.setContent('仍然保留'))
    fireEvent.click(await view.findByRole('button', { name: '停止生成' }))
    await view.findByRole('button', { name: '重试停止' })
    fireEvent.click(view.getByRole('button', { name: '重试停止' }))
    await waitFor(() => expect(release).toBeTypeOf('function'))
    expect(view.container.querySelector('[data-chat-state]')?.getAttribute('data-chat-state')).toBe('stopping')
    expect(editorOf(view).getText()).toBe('仍然保留')
    await act(async () => release())
    await waitFor(() => expect(view.container.querySelector('[data-chat-state]')?.getAttribute('data-chat-state')).toBe('stopped'))
    expect(editorOf(view).getText()).toBe('仍然保留')
    // A later send is not blocked by the stop's synchronous lock.
    expect((view.getByRole('button', { name: '发送', exact: true }) as HTMLButtonElement).disabled).toBe(false)
    expect(attempts).toBe(2)
  } finally { router.dispose() }
})
it('prioritizes stopping over pending interactions without conflating send and run states', () => {
  expect(deriveChatState({ running: true, stopping: true, submitting: false, interaction: approval, stopped: false })).toBe('stopping')
  expect(deriveChatState({ running: true, stopping: false, submitting: false, interaction: approval, stopped: false })).toBe('approval')
})
