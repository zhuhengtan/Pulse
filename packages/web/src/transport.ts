import { createDesktopTransport } from './desktopTransport.js'
import { ChatChannel } from './ChatChannel.js'
import type { WebAttachment, WebAssistantMessageReceipt, WebAssistantWorkInteraction, WebConversation, WebLane, WebMessage, WebProject, WebRunEvent, WebRunSnapshot } from '@hunterzhu/pulse-server/protocol'

export type { WebAttachment, WebAssistantMessageReceipt, WebAssistantWorkInteraction, WebConversation, WebLane, WebMessage, WebProject, WebRunEvent, WebRunSnapshot } from '@hunterzhu/pulse-server/protocol'

export interface PulseWebTransport {
  messages?(id: string, before?: string, signal?: AbortSignal): Promise<{ items: WebMessage[]; before?: string; revision: number }>
  onConnection?(listener: (connected: boolean) => void): () => void
  onChange?(listener: () => void): () => void
  subscribeChat?(runId: string, after: number, onEvent: (event: WebRunEvent) => void, onError: () => void): () => void
  request(path: string, init?: RequestInit): Promise<Response>
  subscribe(path: string, onEvent: (event: WebRunEvent) => void, onError: () => void): () => void
}

export type EventSourceLike = Pick<EventSource, 'onmessage' | 'onerror' | 'onopen' | 'close'>
export type EventSourceFactory = (url: string, options: EventSourceInit) => EventSourceLike

function requestAborted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

export function createBrowserTransport(
  baseUrl = '',
  request: typeof fetch = fetch,
  createEventSource: EventSourceFactory = (url, options) => new EventSource(url, options),
): PulseWebTransport {
  const listeners = new Set<(connected: boolean) => void>()
  const streamsDown = new Set<number>()
  let streamId = 0
  let httpDown = false
  let connected = true
  const publish = () => {
    const next = !httpDown && streamsDown.size === 0
    if (next === connected) return
    connected = next
    for (const listener of listeners) listener(next)
  }
  return {
    onConnection(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async request(path, init = {}) {
      try {
        const response = await request(`${baseUrl}${path}`, { ...init, credentials: 'include' })
        httpDown = false
        publish()
        return response
      } catch (error) {
        if (!requestAborted(error)) { httpDown = true; publish() }
        throw error
      }
    },
    subscribe(path, onEvent, onError) {
      const source = createEventSource(`${baseUrl}${path}`, { withCredentials: true })
      const id = ++streamId
      let closed = false
      source.onopen = () => {
        if (closed) return
        const recovered = streamsDown.delete(id) || httpDown
        httpDown = false
        if (recovered) publish()
      }
      source.onmessage = (message) => {
        try { onEvent(JSON.parse(message.data) as WebRunEvent) } catch { onError() }
      }
      source.onerror = () => {
        if (closed) return
        streamsDown.add(id)
        publish()
        onError()
      }
      return () => {
        closed = true
        streamsDown.delete(id)
        source.close()
        publish()
      }
    },
  }
}

const httpTransport = createBrowserTransport()
const channel = typeof window !== 'undefined' && typeof WebSocket !== 'undefined'
  ? new ChatChannel(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/chat/socket`) : undefined
const webTransport: PulseWebTransport = {
  ...httpTransport,
  messages: async (id, before, signal) => apiJson(httpTransport, `/api/data/conversations/${encodeURIComponent(id)}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`, signal ? { signal } : {}),
  request: (path, init) => channel && path.startsWith('/api/assistant') ? channel.request(path, init) : httpTransport.request(path, init),
  onConnection(listener) {
    let httpUp = true
    let chatUp = true
    const emit = () => listener(httpUp && chatUp)
    const stopHttp = httpTransport.onConnection?.(value => { httpUp = value; emit() }) ?? (() => {})
    const stopChat = channel?.connection(value => { chatUp = value; emit() }) ?? (() => {})
    return () => { stopHttp(); stopChat() }
  },
  ...(channel ? { onChange: (listener: () => void) => channel.changes(listener), subscribeChat: (runId: string, after: number, onEvent: (event: WebRunEvent) => void, onError: () => void) => channel.subscribe(runId, after, onEvent, onError) } : {}),
}

export const browserTransport = typeof window !== 'undefined' && window.pulseDesktop ? createDesktopTransport(window.pulseDesktop) : webTransport

export async function apiJson<T>(transport: PulseWebTransport, path: string, init?: RequestInit): Promise<T> {
  const response = await transport.request(path, init)
  if (!response.ok) {
    let detail: string | undefined
    try { const body = await response.clone().json() as { error?: unknown }; if (typeof body.error === 'string') detail = body.error.slice(0, 200) } catch { /* Non-JSON error responses keep the status only. */ }
    throw new ApiError(response.status, detail)
  }
  return response.json() as Promise<T>
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly detail?: string) { super(detail ? `HTTP_${status}: ${detail}` : `HTTP_${status}`) }
}

/** Keep deep links usable while an older running backend is upgraded separately. */
export async function getWebConversation(transport: PulseWebTransport, id: string): Promise<WebConversation> {
  try { return await apiJson<WebConversation>(transport, `/api/conversations/${encodeURIComponent(id)}`) }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404 || error.detail !== 'NOT_FOUND') throw error
    const archived = await apiJson<WebConversation[]>(transport, '/api/conversations?archived=1')
    const conversation = archived.find(item => item.id === id)
    if (!conversation) throw error
    return conversation
  }
}

export const jsonRequest = (method: string, value?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
})

export type ConversationList = WebConversation[]
export type MessageList = WebMessage[]

export async function readLatestMessages(transport: PulseWebTransport, id: string): Promise<MessageList> {
  return transport.messages ? (await transport.messages(id)).items : apiJson<MessageList>(transport, `/api/web/conversations/${encodeURIComponent(id)}/messages`)
}

/** Reconcile an uncertain send with durable evidence; never repeat the write. */
export async function submitWorkMessage(
  transport: PulseWebTransport,
  conversationId: string,
  payload: Pick<WebMessage, 'text' | 'requestId' | 'attachments' | 'skills' | 'mentionedFiles' | 'richContent'> & { delivery: 'immediate' | 'whenIdle' },
): Promise<{ runId: string }> {
  try {
    return await apiJson(transport, `/api/conversations/${encodeURIComponent(conversationId)}/messages`, jsonRequest('POST', payload))
  } catch (error) {
    // Explicit authorization or payload rejection must not be hidden by readback.
    if (!payload.requestId || (error instanceof ApiError && error.status < 500 && !(error.status === 409 && error.detail === 'CONVERSATION_BUSY'))) throw error
    // Startup may outlive the desktop HTTP timeout. Keep checking the same ID,
    // without resending; a competing request or explicit rejection stays failed.
    for (const delay of error instanceof ApiError && error.status === 409 ? [0] : [0, 2000, 4000, 8000, 16000, 16000]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      try {
        const items = await readLatestMessages(transport, conversationId)
        const message = items.find(item => item.id === `msg-${payload.requestId}` && item.role === 'user')
        const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
        if (message?.runId && !message.bodyTruncated && message.text === payload.text
          && equal(message.richContent ?? null, payload.richContent ?? null)
          && equal((message.attachments ?? []).map(item => item.id), (payload.attachments ?? []).map(item => item.id))
          && equal(message.skills ?? [], payload.skills ?? [])
          && equal(message.mentionedFiles ?? [], payload.mentionedFiles ?? [])) return { runId: message.runId }
        if (items.length) break
      } catch { break /* Keep the original error when readback itself is unavailable. */ }
    }
    throw error
  }
}

export function createPulseSocket(path: string): WebSocket {
  const bridge = window.pulseDesktop
  if (!bridge?.openSocket || !bridge.sockets) return new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`)
  const id = crypto.randomUUID()
  const socket = { readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null,
    send: (value: string) => { void bridge.sendSocket?.(id, value) },
    close: () => { Object.assign(socket, { readyState: 3 }); off(); void bridge.closeSocket?.(id) },
  } as unknown as WebSocket
  const off = bridge.sockets(value => {
    if (value.id !== id) return
    if (value.type === 'open') { Object.assign(socket, { readyState: 1 }); socket.onopen?.call(socket, new Event('open')) }
    if (value.type === 'message') socket.onmessage?.call(socket, new MessageEvent('message', { data: value.data ?? '' }))
    if (value.type === 'error') socket.onerror?.call(socket, new Event('error'))
    if (value.type === 'close') { Object.assign(socket, { readyState: 3 }); off(); socket.onclose?.call(socket, new CloseEvent('close')) }
  })
  void bridge.openSocket(id, path).catch(() => { socket.onerror?.call(socket, new Event('error')); socket.close() })
  return socket
}
