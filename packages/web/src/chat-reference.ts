import type { AssistantContextReference } from '@hunterzhu/pulse-server/protocol'
export function chatReferenceFromQuery(query: URLSearchParams): AssistantContextReference | undefined {
  const projectId = query.get('project') || undefined, conversationId = query.get('referenceConversation') || undefined
  return projectId || conversationId ? { ...(projectId ? { projectId } : {}), ...(conversationId ? { conversationId } : {}) } : undefined
}
export function chatModePath(conversationId?: string, projectId?: string): string {
  const query = new URLSearchParams()
  if (projectId) query.set('project', projectId)
  if (conversationId) query.set('referenceConversation', conversationId)
  return '/chat' + (query.size ? '?' + query : '')
}
