import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Editor } from '@tiptap/core'
import { PulseApp } from '../src/PulseApp.js'
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
it.each(['chat', 'work'] as const)('keeps optimistic %s payload and requires confirmation before retry', async mode => {
  const fixture = routingFixture(), request = fixture.transport.request, posts: any[] = []
  fixture.transport.request = async (path, init) => {
    if (path.endsWith('/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push(body)
      if (posts.length === 1) return Response.json({ error: 'OFFLINE' }, { status: 503 })
      return Response.json(mode === 'chat' ? { conversationId: 'assistant', messageId: body.requestId, runId: 'retry-run', state: 'queued' } : { runId: 'retry-run' })
    }
    return request(path, init)
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport} /> }], { initialEntries: [mode === 'chat' ? '/chat' : '/work/pulse-chat'] })
  const view = render(<PulseDesignSystem><RouterProvider router={router} /></PulseDesignSystem>)
  try {
    await view.findByText(mode === 'chat' ? '我们要做什么？' : '消息：pulse-chat')
    const editor = (view.container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
    act(() => editor.commands.insertContent([{ type: 'text', text: '完整原始需求 ' }, { type: 'skillChip', attrs: { id: 'grill-and-plan', label: 'grill-and-plan' } }, { type: 'text', text: ' ' }, { type: 'fileChip', attrs: { id: '中文目录/a.ts', label: '中文目录/a.ts' } }]))
    fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['附件内容'], 'notes.txt', { type: 'text/plain' })] } })
    await view.findByText('notes.txt')
    fireEvent.click(view.getByRole('button', { name: '发送', exact: true }))
    const retry = await view.findByRole('button', { name: '发送失败，重新发送' })
    expect(retry.textContent).toBe('!'); expect(retry.className).toContain('message-retry')
    expect(posts).toHaveLength(1)
    fireEvent.click(retry)
    expect(await view.findByRole('dialog')).toBeTruthy()
    expect(posts).toHaveLength(1)
    fireEvent.click(view.getByRole('button', { name: '取消', exact: true }))
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
    expect(posts).toHaveLength(1)
    fireEvent.click(retry)
    fireEvent.click(await view.findByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect(posts).toHaveLength(2))
    const { retry: _retry, ...second } = posts[1]
    expect(second).toEqual(posts[0])
    expect(second.skills).toEqual(['grill-and-plan'])
    expect(second.mentionedFiles).toContain('中文目录/a.ts')
    expect(second.attachments[0].data).toContain('base64,')
  } finally { router.dispose() }
})
