import type { WebAssistantMessageReceipt, WebAssistantWorkInteraction, WebConversation, WebLane, WebMessage, WebProject, WebRunEvent, WebRunSnapshot } from '@hunterzhu/pulse-server/protocol'

export type { WebAssistantMessageReceipt, WebAssistantWorkInteraction, WebConversation, WebLane, WebMessage, WebProject, WebRunEvent, WebRunSnapshot } from '@hunterzhu/pulse-server/protocol'

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

export const jsonRequest = (method: string, value?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
})

export type ConversationList = WebConversation[]
export type MessageList = WebMessage[]
