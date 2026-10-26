import type { ComposerPayload } from './RichComposer.js'
import { apiJson, type PulseWebTransport, type WebMessage } from './transport.js'

export type MessagePayload = Pick<WebMessage, 'text' | 'attachments' | 'skills' | 'mentionedFiles' | 'richContent' | 'assistantContext'>

/** Snapshot the same complete content for delivery, durable queuing and retries. */
export function messagePayload(source: ComposerPayload): MessagePayload {
  return structuredClone({ text: source.text,
    ...(source.attachments !== undefined ? { attachments: source.attachments } : {}),
    ...(source.skills !== undefined ? { skills: source.skills } : {}),
    ...(source.mentionedFiles !== undefined ? { mentionedFiles: source.mentionedFiles } : {}),
    ...(source.richContent !== undefined ? { richContent: source.richContent } : {}),
    ...(source.assistantContext !== undefined ? { assistantContext: source.assistantContext } : {}),
  })
}

/** A rendered page is a preview, never a source for replaying an original request. */
export async function retryMessagePayload(transport: PulseWebTransport, conversationId: string, message: WebMessage): Promise<MessagePayload> {
  if (!message.bodyTruncated) return messagePayload(message)
  try {
    const body = await apiJson<WebMessage>(transport, `/api/data/conversations/${encodeURIComponent(conversationId)}/body?id=${encodeURIComponent(message.id)}`)
    if (body.id !== message.id || typeof body.text !== 'string' || body.bodyTruncated) throw new Error('ORIGINAL_MESSAGE_UNAVAILABLE')
    return messagePayload(body)
  } catch { throw new Error('ORIGINAL_MESSAGE_UNAVAILABLE') }
}
