import type { WebAttachment, WebAssistantMessageReceipt, WebAssistantWorkInteraction, WebConversation, WebLane, WebMessage, WebProject, WebRunEvent, WebRunSnapshot } from '@hunterzhu/pulse-server/protocol'

export type { WebAttachment, WebAssistantMessageReceipt, WebAssistantWorkInteraction, WebConversation, WebLane, WebMessage, WebProject, WebRunEvent, WebRunSnapshot } from '@hunterzhu/pulse-server/protocol'

export interface PulseWebTransport {
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

export const browserTransport = createBrowserTransport()

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
