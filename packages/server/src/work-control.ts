import { AsyncLocalStorage } from 'node:async_hooks'
import type { ConversationData } from '@hunterzhu/pulse-data'
import type { WorkControl } from './protocol.js'
import { isConversationId } from './security.js'
/** Actor identity comes from server/CLI entrypoints or private worker IPC, never HTTP bodies. */
export interface WorkActor { kind: 'user' | 'assistant' | 'policy' | 'system' | 'approval'; revision?: number; assistantConversationId?: string }
const context = new AsyncLocalStorage<WorkActor>()
export const currentWorkActor = (): WorkActor => context.getStore() ?? { kind: 'user' }
export function withWorkActor<T>(actor: WorkActor, work: () => T): T { return context.run(actor, work) }
function rejectIllegalConversationId(id: string): void {
  if (!isConversationId(id)) throw new Error('INVALID_CONVERSATION_ID')
}
export async function checkWorkControl(data: ConversationData, id: string, operation: string): Promise<WorkControl | undefined> {
  rejectIllegalConversationId(id)
  return data.call('checkWorkControl', id, currentWorkActor(), operation)
}
export async function asChatWorkAgent<T>(data: ConversationData, id: string, work: () => Promise<T>, expectedRevision?: number): Promise<T> {
  rejectIllegalConversationId(id)
  const conversation = await data.call<{ control?: WorkControl }>('get', id)
  if (!conversation.control) throw new Error('WORK_NOT_ASSISTANT_MANAGED')
  return withWorkActor({ kind: 'assistant', revision: expectedRevision ?? conversation.control.revision, assistantConversationId: conversation.control.assistantConversationId }, async () => { await checkWorkControl(data, id, 'agent'); return work() })
}
