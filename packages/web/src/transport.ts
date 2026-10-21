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

export type EventSourceLike = Pick<EventSource, 'onmessage' | 'onerror' | 'close'>
export type EventSourceFactory = (url: string, options: EventSourceInit) => EventSourceLike

export function createBrowserTransport(
  baseUrl = '',
  request: typeof fetch = fetch,
  createEventSource: EventSourceFactory = (url, options) => new EventSource(url, options),
): PulseWebTransport {
  return {
    request: (path, init = {}) => request(`${baseUrl}${path}`, { ...init, credentials: 'include' }),
    subscribe(path, onEvent, onError) {
      const source = createEventSource(`${baseUrl}${path}`, { withCredentials: true })
      source.onmessage = (message) => {
        try { onEvent(JSON.parse(message.data) as WebRunEvent) } catch { onError() }
      }
      source.onerror = onError
      return () => source.close()
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
