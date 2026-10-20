import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Editor } from '@tiptap/core'
import { PulseApp, InteractionPanel } from '../src/PulseApp.js'
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })
async function open(mode: 'chat' | 'work' | 'new', custom?: (path: string, init?: RequestInit) => Promise<Response> | undefined) {
  const fixture = routingFixture(), original = fixture.transport.request
  fixture.transport.request = (path, init) => custom?.(path, init) ?? original(path, init)
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport} /> }], { initialEntries: [mode === 'chat' ? '/chat' : mode === 'new' ? '/work/new' : '/work/pulse-chat'] })
  const view = render(<PulseDesignSystem><RouterProvider router={router} /></PulseDesignSystem>)
  await view.findByText(mode === 'work' ? '消息：pulse-chat' : '我们要做什么？')
  const editor = () => (view.container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
  return { fixture, router, view, editor }
}
it.each(['chat', 'work', 'new'] as const)('clears %s input with its optimistic bubble and restores the full draft on rejection', async mode => {
  let finish!: (response: Response) => void
  const posted: unknown[] = []
  const pending = new Promise<Response>(resolve => { finish = resolve })
  const app = await open(mode, (path, init) => {
    if (path.endsWith('/messages') && init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return pending }
  })
  try {
    act(() => app.editor().commands.insertContent([{ type: 'skillChip', attrs: { id: 'grill-and-plan', label: 'grill-and-plan' } }, { type: 'text', text: ' 立即清空的原始需求' }]))
    fireEvent.change(app.view.container.querySelector('input[type=file]')!, { target: { files: [new File(['test content'], 'draft-note.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(app.view.container.querySelector('.composer-attachments')?.textContent).toContain('draft-note.txt'))
    const document = app.editor().getJSON()
    fireEvent.click(app.view.getByRole('button', { name: '发送', exact: true }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(app.view.container.querySelector('.message.user .bubble')?.textContent).toContain('立即清空的原始需求')
    expect(app.editor().getText()).toBe('')
    expect(app.view.container.querySelector('.composer-attachments')).toBeNull()
    await act(async () => finish(Response.json({ error: 'OFFLINE' }, { status: 503 })))
    await app.view.findByRole('button', { name: '发送失败，重新发送' })
    await waitFor(() => expect(app.editor().getJSON()).toEqual(document))
    expect(app.view.container.querySelector('.composer-attachments')?.textContent).toContain('draft-note.txt')
  } finally { finish(Response.json({ error: 'OFFLINE' }, { status: 503 })); app.router.dispose() }
})
it.each(['chat', 'work'] as const)('does not overwrite a later %s draft when a send fails or succeeds', async mode => {
  let finish!: (response: Response) => void
  let posts = 0
  const pending = new Promise<Response>(resolve => { finish = resolve })
  const app = await open(mode, (path, init) => { if (path.endsWith('/messages') && init?.method === 'POST') { posts++; return pending } })
  try {
    act(() => app.editor().commands.insertContent('已发送的原稿'))
    fireEvent.click(app.view.getByRole('button', { name: '发送', exact: true }))
    await waitFor(() => expect(posts).toBe(1))
    expect(app.editor().getText()).toBe('')
    // A later edit must survive even if it reaches the same revision as a proposed rollback.
    act(() => app.editor().commands.insertContent('下一条新草稿'))
    await act(async () => finish(Response.json({ error: 'OFFLINE' }, { status: 503 })))
    const retry = await app.view.findByRole('button', { name: '发送失败，重新发送' })
    expect(app.editor().getText()).toBe('下一条新草稿')
    const original = app.fixture.transport.request
    app.fixture.transport.request = async (path, init) => path.endsWith('/messages') && init?.method === 'POST'
      ? Response.json(mode === 'chat' ? { conversationId: 'assistant', messageId: JSON.parse(String(init.body)).requestId, runId: 'retry-run', state: 'queued' } : { runId: 'retry-run' })
      : original(path, init)
    fireEvent.click(retry); fireEvent.click(await app.view.findByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect(app.view.queryByRole('dialog')).toBeNull())
    expect(app.editor().getText()).toBe('下一条新草稿')
  } finally { finish(Response.json({ error: 'OFFLINE' }, { status: 503 })); app.router.dispose() }
})
it('restores only the origin draft after switching sessions while a request is pending', async () => {
  let finish!: (response: Response) => void; let posted = false
  const pending = new Promise<Response>(resolve => { finish = resolve })
  const app = await open('work', (path, init) => { if (path.endsWith('/messages') && init?.method === 'POST') { posted = true; return pending } })
  try {
    act(() => app.editor().commands.insertContent('原会话消息'))
    fireEvent.click(app.view.getByRole('button', { name: '发送', exact: true })); await waitFor(() => expect(posted).toBe(true))
    expect(app.editor().getText()).toBe('')
    await act(async () => { await app.router.navigate('/work/new') }); await app.view.findByText('我们要做什么？')
    act(() => app.editor().commands.insertContent('另一个会话的草稿'))
    await act(async () => finish(Response.json({ error: 'OFFLINE' }, { status: 503 })))
    expect(app.editor().getText()).toBe('另一个会话的草稿')
    await act(async () => { await app.router.navigate('/work/pulse-chat') }); await app.view.findByText('消息：pulse-chat')
    await waitFor(() => expect(app.editor().getText()).toBe('原会话消息'))
  } finally { finish(Response.json({ error: 'OFFLINE' }, { status: 503 })); app.router.dispose() }
})

const interaction = { kind: 'interaction' as const, runId: 'run-busy', groupId: 'approval-http-mobile', interactionKind: 'approval' as const, items: [{ effectId: 'approval-effect', input: { prompt: '确认隔离测试操作', tools: [{ toolName: 'fs.list', details: { path: '.' } }] } }] }
it.each([true, false])('submits manual approval=%s without randomUUID on an insecure HTTP browser', async approved => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
  const fixture = routingFixture(), original = fixture.transport.request, replies: Array<Record<string, any>> = []
  fixture.transport.request = async (path, init) => {
    if (path.endsWith('/state')) return Response.json({ runId: 'run-busy', state: 'running', seq: 0, activities: [], interactions: [{ groupId: interaction.groupId, kind: 'approval', items: interaction.items }] })
    if (path.endsWith('/replies')) { const body = JSON.parse(String(init?.body)); replies.push(body); return Response.json({ ok: true }) }
    return original(path, init)
  }
  fixture.transport.subscribe = (_path, onEvent) => { queueMicrotask(() => onEvent({ type: 'interactions', runId: 'run-busy', seq: 1, data: { interactions: [{ groupId: interaction.groupId, kind: 'approval', items: interaction.items }] } })); return () => {} }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport} /> }], { initialEntries: ['/work/busy'] })
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  try {
    await view.findByRole('button', { name: '允许本次' }, { timeout: 5000 })
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined })
    fireEvent.click(view.getByRole('button', { name: approved ? '允许本次' : '拒绝', exact: true }))
    await waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toMatchObject({ conversationId: 'busy', groupId: interaction.groupId, answers: [{ effectId: 'approval-effect', value: approved ? { approved: true } : { approved: false, reason: '用户拒绝' } }] })
    expect(replies[0]!.requestId).toMatch(/^[A-Za-z0-9_-]{8,120}$/)
    await waitFor(() => expect(view.queryByRole('button', { name: '允许本次' })).toBeNull())
  } finally { if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor); else delete (globalThis.crypto as any).randomUUID; router.dispose() }
})
it('shows a recoverable error if approval submission unexpectedly rejects', async () => {
  render(<PulseDesignSystem><InteractionPanel interaction={interaction} reviewNote="" delegated running stopping={false} stop={() => {}} submit={async () => { throw new Error('offline') }} setApprovalPolicy={async () => true} /></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('button', { name: '允许本次' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  await waitFor(() => expect((screen.getByRole('button', { name: '允许本次' }) as HTMLButtonElement).disabled).toBe(false))
})
it('keeps approval retries idempotent when request storage is unavailable', async () => {
  const fixture = routingFixture(), original = fixture.transport.request, replies: any[] = []
  fixture.transport.request = async (path, init) => {
    if (path.endsWith('/state')) return Response.json({ runId: 'run-busy', state: 'running', seq: 0, activities: [], interactions: [{ groupId: interaction.groupId, kind: 'approval', items: interaction.items }] })
    if (path.endsWith('/replies')) { replies.push(JSON.parse(String(init?.body))); return replies.length === 1 ? Response.json({ error: 'OFFLINE' }, { status: 503 }) : Response.json({ ok: true }) }
    return original(path, init)
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: ['/work/busy'] })
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  try {
    await view.findByRole('button', { name: '允许本次' }, { timeout: 5000 })
    const read = Storage.prototype.getItem, write = Storage.prototype.setItem, remove = Storage.prototype.removeItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) { if (key.startsWith('pulse-web-interaction-request:')) throw new DOMException('blocked'); return read.call(this, key) })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key.startsWith('pulse-web-interaction-request:')) throw new DOMException('blocked'); return write.call(this, key, value) })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) { if (key.startsWith('pulse-web-interaction-request:')) throw new DOMException('blocked'); return remove.call(this, key) })
    fireEvent.click(view.getByRole('button', { name: '允许本次' })); await view.findByRole('alert')
    fireEvent.click(view.getByRole('button', { name: '允许本次' }))
    await waitFor(() => expect(replies).toHaveLength(2)); expect(replies[1]).toEqual(replies[0])
    await waitFor(() => expect(view.queryByRole('button', { name: '允许本次' })).toBeNull())
  } finally { router.dispose() }
})

it('shows question, background and option descriptions separately and submits a textarea answer', async () => {
  const submit = vi.fn(async () => true)
  const ask = { kind: 'interaction' as const, runId: 'ask-custom', groupId: 'custom', interactionKind: 'ask' as const, items: [{ effectId: 'question', input: { type: 'choice', prompt: '选择迁移方式？', context: '需要保留现有会话。', options: [{ label: '渐进调整（推荐）', value: 'incremental', description: '逐步验证，便于回退。' }, { label: '', value: '' }] } }] }
  const view = render(<PulseDesignSystem><InteractionPanel interaction={ask} reviewNote="" delegated={false} running={false} stopping={false} stop={() => {}} submit={submit} setApprovalPolicy={async () => true} /></PulseDesignSystem>)
  expect(view.getByRole('heading', { name: '选择迁移方式？' }).textContent).toBe('选择迁移方式？')
  expect(view.getByText('需要保留现有会话。').className).toBe('question-background')
  expect(view.getByRole('button', { name: /渐进调整（推荐）/ }).textContent).toContain('逐步验证，便于回退。')
  expect(view.container.querySelectorAll('.question-options button')).toHaveLength(1)
  const input = view.getByRole('textbox', { name: '自行回答' })
  expect(input.tagName).toBe('TEXTAREA')
  fireEvent.change(input, { target: { value: '按模块迁移。\n保留旧入口。' } })
  fireEvent.click(view.getByRole('button', { name: '检查答案' }))
  expect(view.getByText('按模块迁移。 保留旧入口。')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: '统一提交' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith([{ effectId: 'question', value: { text: '按模块迁移。\n保留旧入口。' } }]))
})

it('selects the new conversation approval mode from a dropdown', async () => {
  const app = await open('new')
  try {
    const select = app.view.getByRole('combobox', { name: '审核模式' })
    fireEvent.mouseDown(select)
    fireEvent.click(await screen.findByText('自动审核', { selector: '.ant-select-item-option-content' }))
    expect(app.view.container.querySelector('.approval-policy-select')?.textContent).toContain('自动审核')
    expect(select.getAttribute('aria-pressed')).toBeNull()
  } finally { app.router.dispose() }
})
