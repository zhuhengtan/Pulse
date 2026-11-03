import { createHash } from 'node:crypto'
import type { WebMessage, WebPendingInteraction } from './protocol.js'
export type WorkCallbackKind = 'approval' | 'question' | 'approval_resolved' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'pending' | 'conflict' | 'returned'
export interface WorkCallback {
  id: string
  conversationId: string
  runId: string
  kind: WorkCallbackKind
  title: string
  projectId?: string
  summary: string
  controlRevision: number
  interaction?: WebPendingInteraction
  fingerprint?: string
  state: 'queued' | 'processing' | 'completed' | 'blocked'
  assistantRunId?: string
  createdAt: string
  error?: string
  answered?: boolean
  decision?: string
}

export function callbackWorkState(kind: WorkCallbackKind): NonNullable<WebMessage['work']>['state'] {
  if (kind === 'approval' || kind === 'question') return 'waiting'
  if (kind === 'approval_resolved' || kind === 'returned') return 'running'
  return kind
}

export function interactionFingerprint(group: WebPendingInteraction): string {
  const items = group.items.map(item => { const { execPolicy: _policy, ...input } = item.input; return { effectId: item.effectId, input } }).sort((a,b) => a.effectId.localeCompare(b.effectId))
  return createHash('sha256').update(JSON.stringify({ groupId: group.groupId, kind: group.kind, items })).digest('hex')
}
export function workCallback(input: Omit<WorkCallback, 'id' | 'createdAt' | 'state'>): WorkCallback {
  const fingerprint = input.fingerprint ?? (input.interaction ? interactionFingerprint(input.interaction) : undefined)
  const key = [input.conversationId, input.runId, input.kind, ['approval', 'question', 'approval_resolved', 'returned'].includes(input.kind) ? input.controlRevision : undefined, input.interaction?.groupId, fingerprint]
  return { ...input, id: 'callback-' + createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0,32), ...(fingerprint ? { fingerprint } : {}), state: 'queued', createdAt: new Date().toISOString() }
}

/** Questions may be clarified by the agent; human permission never may. */
export function agentAnswerableQuestion(input: Record<string, unknown>): boolean {
  if (input.toolName === 'ask.confirm' || input.tool === 'ask.confirm') return false
  if (/(?:execution|approval|authoriz|permission|confirm)/i.test(String(input.decisionScope ?? '') + ' ' + String(input.decisionId ?? ''))) return false
  return !/(?:同意|批准|授权|允许|是否.{0,8}执行|是否.{0,8}继续|approve|authoriz|permission|allow|execute the plan)/i.test(String(input.prompt ?? '') + ' ' + JSON.stringify(input.options ?? []))
}
