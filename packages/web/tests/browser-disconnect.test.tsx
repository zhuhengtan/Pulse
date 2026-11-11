import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ChatChannel } from '../src/ChatChannel.js'
import { PulseApp } from './RouterApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { createBrowserTransport, type EventSourceLike } from '../src/transport.js'
import { sidebarFixture } from './fixtures/sidebar.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

function sourceFactory() {
  let source: EventSourceLike | undefined
  const create = () => {
    source = { onmessage: null, onerror: null, onopen: null, close() {} }
    return source
  }
  return { create, get source() { return source } }
}

describe('browser transport connection mark', () => {
  it.each(['randomUUID', 'crypto'])('loads and sends chat when LAN HTTP has no %s', async missing => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    const original = globalThis.crypto
    const frames: Array<{ id: string; path: string; method: string; body?: unknown }> = []
    const socket = {
      readyState: 0,
      onopen: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      onclose: null as ((event: CloseEvent) => void) | null,
      send(text: string) { frames.push(JSON.parse(text)) },
      close() { this.readyState = 3; this.onclose?.(new CloseEvent('close')) },
    }
    const channel = new ChatChannel('ws://192.168.1.2/api/chat/socket', () => socket as unknown as WebSocket)
    try {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: missing === 'crypto' ? undefined : { getRandomValues: original.getRandomValues.bind(original) } })
      const loaded = channel.request('/api/assistant')
      // Attach rejection handling immediately, so the original regression fails cleanly.
      const loadResult = loaded.then(response => response.json(), error => ({ error: error.message }))
      socket.readyState = 1; socket.onopen?.(new Event('open'))
      await waitFor(() => expect(frames).toHaveLength(1))
      const payload = { text: 'hello', requestId: 'send-stable-id' }
      const sent = channel.request('/api/assistant/messages', { method: 'POST', body: JSON.stringify(payload) })
      const sendResult = sent.then(response => response.json(), error => ({ error: error.message }))
      await waitFor(() => expect(frames).toHaveLength(2))
      expect(frames[0]).toMatchObject({ path: '/api/assistant', method: 'GET' })
      expect(frames[1]).toMatchObject({ path: '/api/assistant/messages', method: 'POST', body: payload })
      expect(frames[0]!.id).not.toBe(frames[1]!.id)
      for (const [index, frame] of frames.entries()) socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'response', id: frame.id, status: 200, body: { index } }) }))
      expect(await loadResult).toEqual({ index: 0 })
      expect(await sendResult).toEqual({ index: 1 })
    } finally {
      channel.close()
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
      else Reflect.deleteProperty(globalThis, 'crypto')
    }
  })

  it('updates the real browser transport connection mark on SSE disconnection', async () => {
    const base = sidebarFixture().transport
    const events = sourceFactory()
    const transport = createBrowserTransport('http://fixture.local', async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/runs/run-busy/state') return Response.json({ runId: 'run-busy', state: 'running', seq: 1, activities: [] })
      if (path === '/api/runs/run-busy/trace') return Response.json({ events: [], seq: 1 })
      return base.request(path + new URL(String(input)).search, init)
    }, events.create)
    render(<PulseDesignSystem><PulseApp transport={transport} /></PulseDesignSystem>)
    await screen.findByText(/^(?:我们要做什么？|聊点什么？)$/)
    fireEvent.click(screen.getByRole('tab', { name: '工作' }))
    fireEvent.click(await screen.findByRole('button', { name: /^正在执行的任务/ }))
    await waitFor(() => expect(events.source?.onerror).toBeTypeOf('function'))
    expect(screen.getByRole('status', { name: '服务已连接' })).toBeTruthy()
    expect(screen.getByRole('status', { name: '执行中' })).toBeTruthy()
    act(() => events.source?.onerror?.(new Event('error')))
    expect(await screen.findByRole('status', { name: '服务未连接' })).toBeTruthy()
    expect(screen.queryByRole('status', { name: '任务执行失败' })).toBeNull()
    expect(screen.queryByRole('status', { name: '任务验收通过' })).toBeNull()
    expect(screen.getByTitle('正在执行的任务').textContent).toBe('正在执行的任务')
    act(() => events.source?.onopen?.(new Event('open')))
    expect(await screen.findByRole('status', { name: '服务已连接' })).toBeTruthy()
  })

  it('does not treat bad JSON, an aborted request, or a closed stream as a service outage', async () => {
    const events = sourceFactory()
    let fail = false
    const marks: boolean[] = []
    const transport = createBrowserTransport('', async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (fail) throw new TypeError('Failed to fetch')
      return Response.json({})
    }, events.create)
    transport.onConnection?.(value => marks.push(value))
    const controller = new AbortController()
    controller.abort()
    await expect(transport.request('/api/session', { signal: controller.signal })).rejects.toThrow(/Aborted/)
    const stop = transport.subscribe('/events', () => {}, () => {})
    events.source?.onmessage?.(new MessageEvent('message', { data: '{' }))
    stop()
    events.source?.onerror?.(new Event('error'))
    expect(marks).toEqual([])
    fail = true
    await expect(transport.request('/api/session')).rejects.toThrow(TypeError)
    expect(marks).toEqual([false])
    fail = false
    await transport.request('/api/session')
    expect(marks).toEqual([false, true])
  })

  it('reports ChatChannel drops and restores without treating bad frames, aborts, or shutdown as an outage', async () => {
    vi.useFakeTimers()
    const sockets: Array<{ readyState: number; onopen: ((event: Event) => void) | null; onmessage: ((event: MessageEvent) => void) | null; onclose: ((event: CloseEvent) => void) | null }> = []
    const channel = new ChatChannel('ws://fixture.local/api/chat/socket', () => {
      const socket = {
        readyState: 0,
        onopen: null as ((event: Event) => void) | null,
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onclose: null as ((event: CloseEvent) => void) | null,
        send() {},
        close(code = 1000) { this.readyState = 3; this.onclose?.(new CloseEvent('close', { code })) },
      }
      sockets.push(socket)
      return socket as unknown as WebSocket
    })
    try {
      const marks: boolean[] = []
      channel.connection(value => marks.push(value))
      channel.subscribe('run', 0, () => {}, () => {})
      const opened = sockets[0]
      expect(opened).toBeTruthy()
      opened!.readyState = 1
      opened!.onopen?.(new Event('open'))
      expect(marks).toEqual([])
      const controller = new AbortController()
      const pending = channel.request('/api/assistant', { signal: controller.signal })
      controller.abort()
      await expect(pending).rejects.toThrow(/Aborted/)
      expect(marks).toEqual([])
      opened!.onclose?.(new CloseEvent('close', { code: 1006 }))
      expect(marks).toEqual([false])
      const late: boolean[] = []
      channel.connection(value => late.push(value))
      expect(late).toEqual([false])
      await vi.advanceTimersByTimeAsync(300)
      const restored = sockets.at(-1)
      expect(restored).toBeTruthy()
      restored!.readyState = 1
      restored!.onopen?.(new Event('open'))
      expect(marks.at(-1)).toBe(true)
      restored!.onmessage?.(new MessageEvent('message', { data: '{' }))
      expect(marks.at(-1)).toBe(true)
      channel.close()
      expect(marks.at(-1)).toBe(true)
    } finally {
      channel.close()
      vi.useRealTimers()
    }
  })
})
