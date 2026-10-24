import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../src/MessageBubble.js'
import { copyText } from '../src/clipboard.js'
import type { WebMessage } from '../src/transport.js'

vi.mock('../src/clipboard.js', () => ({ copyText: vi.fn().mockResolvedValue(undefined) }))

beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    pointerType: string
    pointerId: number
    isPrimary: boolean
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerType = init.pointerType ?? 'touch'
      this.pointerId = init.pointerId ?? 1
      this.isPrimary = init.isPrimary ?? true
    }
  }
  Object.defineProperty(window, 'PointerEvent', { value: TestPointerEvent, configurable: true })
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }), configurable: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => { vi.useFakeTimers(); vi.mocked(copyText).mockReset().mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.useRealTimers() })

const message: WebMessage = { id: 'message-1', role: 'assistant', text: '**你好**，Pulse', createdAt: '2026-10-12T00:00:00Z' }
function show(value: WebMessage = message, mode: 'chat' | 'work' = 'chat') {
  const result = render(<MessageBubble message={value} mode={mode} retry={vi.fn()} onOpenWork={vi.fn()}/>)
  return { ...result, bubble: result.container.querySelector('.bubble')! }
}
function hold(element: Element, ms = 450) {
  fireEvent.pointerDown(element, { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 20, clientY: 20 })
  act(() => { vi.advanceTimersByTime(ms) })
}

describe('message presentation and copying', () => {
  it('preserves local timestamp labels and titles when the message date changes', () => {
    const view = show()
    for (const createdAt of [message.createdAt, '2026-01-01T03:04:05Z']) {
      view.rerender(<MessageBubble message={{ ...message, createdAt }} mode="chat" retry={vi.fn()} onOpenWork={vi.fn()}/>)
      const date = new Date(createdAt), time = screen.getByLabelText('发送时间')
      expect(time.textContent).toBe(new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date).replaceAll('/', '-'))
      expect(time.getAttribute('title')).toBe(`${date.toLocaleString('zh-CN', { hour12: false })}（本地时间）`)
      expect(time.getAttribute('datetime')).toBe(date.toISOString())
    }
  })
  it('keeps invalid message timestamps hidden', () => {
    show({ ...message, createdAt: '' })
    expect(screen.queryByLabelText('发送时间')).toBeNull()
  })
  it('keeps file and image callbacks scoped to the current run and view', () => {
    const previousFile = vi.fn(), currentFile = vi.fn()
    const previousImage = vi.fn(() => undefined), currentImage = vi.fn(() => undefined)
    const text = '[文档](plan.md) ![图片](assets/test.png)'
    const view = render(<MessageBubble message={{ ...message, text, runId: 'run-a' }} mode="work" retry={vi.fn()} onOpenWork={vi.fn()} onFileClick={previousFile} imageApi={previousImage}/>)
    fireEvent.click(screen.getByRole('button', { name: '文档', exact: true }))
    expect(previousFile).toHaveBeenCalledWith('plan.md', 'run-a')
    expect(previousImage).toHaveBeenCalledWith('assets/test.png', 'run-a')
    view.rerender(<MessageBubble message={{ ...message, text, runId: 'run-b' }} mode="work" retry={vi.fn()} onOpenWork={vi.fn()} onFileClick={currentFile} imageApi={currentImage}/>)
    fireEvent.click(screen.getByRole('button', { name: '文档', exact: true }))
    expect(currentFile).toHaveBeenCalledWith('plan.md', 'run-b')
    expect(currentImage).toHaveBeenCalledWith('assets/test.png', 'run-b')
    expect(previousFile).toHaveBeenCalledTimes(1)
  })
  it('keeps chat/work presentation explicit and user messages copyable', async () => {
    const view = show({ ...message, role: 'user' }, 'work')
    expect(view.container.querySelector('.message--work.user')).not.toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制消息' })) })
    expect(copyText).toHaveBeenCalledWith(message.text)
    expect(screen.getByRole('status').textContent).toBe('已复制')
  })
  it('copies the latest streaming text without copying task metadata', async () => {
    const view = show({ ...message, deliveryState: 'replying', work: { conversationId: 'work-1', title: '工作卡片', state: 'running' } })
    view.rerender(<MessageBubble message={{ ...message, text: '最新回复' }} mode="chat" retry={vi.fn()} onOpenWork={vi.fn()}/>)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制回复' })) })
    expect(copyText).toHaveBeenCalledWith('最新回复')
  })
  it('reports copy failure and allows a later retry', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('denied'))
    show()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制回复' })) })
    expect(screen.getByRole('status').textContent).toContain('复制失败')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制回复' })) })
    expect(screen.getByRole('status').textContent).toBe('已复制')
  })
  it('does not offer message copying for empty work-only cards', () => {
    show({ ...message, text: '', work: { conversationId: 'work-1', title: '任务', state: 'running' } })
    expect(screen.queryByRole('button', { name: '复制回复' })).toBeNull()
    expect(screen.getByRole('button', { name: /查看工作会话/ })).not.toBeNull()
  })
})

describe('long-press message menu', () => {
  it('opens only after 450ms, stays open after release, copies raw text', async () => {
    const { bubble } = show()
    hold(bubble, 449)
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('menu')).not.toBeNull()
    fireEvent.pointerUp(bubble)
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '复制' })) })
    expect(copyText).toHaveBeenCalledWith(message.text)
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it.each(['scroll', 'pointercancel', 'move'])('cancels pending long press on %s', kind => {
    const { bubble } = show()
    hold(bubble, 200)
    if (kind === 'scroll') fireEvent.scroll(document)
    else if (kind === 'pointercancel') fireEvent.pointerCancel(bubble)
    else fireEvent.pointerMove(bubble, { pointerId: 1, clientX: 31, clientY: 20 })
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('closes an open menu on scrolling, Escape and outside click', () => {
    const { bubble } = show()
    hold(bubble)
    fireEvent.scroll(document)
    expect(screen.queryByRole('menu')).toBeNull()
    hold(bubble)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    hold(bubble)
    fireEvent.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('closes on identity change and allows only one message menu', () => {
    const view = show()
    hold(view.bubble)
    const second = show({ ...message, id: 'message-2' })
    hold(second.bubble)
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(view.bubble.classList.contains('has-message-menu')).toBe(false)
    second.rerender(<MessageBubble message={{ ...message, id: 'new-conversation-message' }} mode="work" retry={vi.fn()} onOpenWork={vi.fn()}/>)
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('ignores mouse presses, links, code blocks and tables', () => {
    const { bubble, container } = show({ ...message, text: '[链接](https://example.com)\n\n```js\nconst x = 1\n```\n\n| A |\n| --- |\n| B |' })
    fireEvent.pointerDown(bubble, { pointerType: 'mouse', isPrimary: true })
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('menu')).toBeNull()
    for (const element of container.querySelectorAll('a, .code-block, .table-scroll')) {
      hold(element)
      expect(screen.queryByRole('menu')).toBeNull()
    }
  })
  it('cancels its timer when unmounted', () => {
    const { bubble, unmount } = show()
    hold(bubble, 200)
    unmount()
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('supports a keyboard context menu and cancels a release outside the bubble', () => {
    const { bubble } = show()
    hold(bubble, 200)
    fireEvent.pointerUp(document.body)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.keyDown(screen.getByLabelText('Pulse 消息'), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu')).not.toBeNull()
  })
})
