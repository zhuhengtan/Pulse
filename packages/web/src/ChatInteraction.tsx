import { useRef, useState } from 'react'
import { InteractionPanel, type PendingInteraction } from './InteractionPanel.js'
import { AnsweredQuestion } from './AnsweredQuestion.js'
import { PulseButton } from './PulseControls.js'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'
import type { ChatWorkAction } from '@hunterzhu/pulse-server/protocol'
type Answers = Array<{ effectId: string; value: Record<string, unknown> }>
export function ChatInteractionContent({ interaction, submit, notificationTarget }: { notificationTarget?: string | undefined; interaction: PendingInteraction; submit(answers: Answers): Promise<boolean> }) {
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState('')
  const lock = useRef(false)
  const answer = async (approved: boolean) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { if (await submit(interaction.items.map(item => ({ effectId: item.effectId, value: { approved } })))) setDone(true); else setError('提交未完成，事项可能已变化，请重试或查看工作会话。') }
    catch { setError('提交未完成，请检查连接后重试。') }
    finally { lock.current = false; setBusy(false) }
  }
  if (done) return <small role="status">已处理</small>
  if (interaction.interactionKind === 'ask') return <InteractionPanel notificationTarget={notificationTarget} interaction={interaction} reviewNote="" delegated={false} submit={submit}/>
  const operations = interaction.items.flatMap(item => Array.isArray(item.input.tools) ? item.input.tools : [])
  return <div className="chat-approval" aria-label="聊天审批" aria-busy={busy}>
    <p>这一步需要你确认，是否允许继续？</p>
    {operations.length > 0 && <details><summary>查看操作详情（{operations.length} 项）</summary><pre>{JSON.stringify(operations, null, 2)}</pre></details>}
    {error && <p role="alert">{error}</p>}
    <div className="chat-approval-actions"><PulseButton disabled={busy} onClick={() => void answer(false)}>拒绝</PulseButton><PulseButton disabled={busy} onClick={() => void answer(true)}>{busy ? '正在提交…' : '同意'}</PulseButton></div>
  </div>
}
export function ChatWorkPrompt({ action, transport, notificationTarget }: { action: ChatWorkAction; transport: PulseWebTransport; notificationTarget?: string | undefined }) {
  const [submitted, setSubmitted] = useState<Answers>()
  if (action.state === 'answered' || submitted) {
    const answers = submitted ?? action.answers
    if (action.interaction.kind === 'ask' && answers) return <>{action.interaction.items.map(item => {
      const answer = answers.find(answer => answer.effectId === item.effectId)
      return answer ? <AnsweredQuestion key={item.effectId} question={{ ...item, answer: answer.value }}/> : null
    })}</>
    return <small role="status">此事项已处理</small>
  }
  if (action.state === 'obsolete') return <small role="status">此事项已变化，可打开工作对话查看。</small>
  if (notificationTarget && action.interaction.kind === 'ask' && action.interaction.groupId !== notificationTarget) return null
  const interaction: PendingInteraction = { kind: 'interaction', runId: action.runId, groupId: action.interaction.groupId, interactionKind: action.interaction.kind, items: action.interaction.items }
  return <ChatInteractionContent notificationTarget={notificationTarget} interaction={interaction} submit={async answers => {
    try { await apiJson(transport, `/api/assistant/work/${encodeURIComponent(action.conversationId)}/replies`, jsonRequest('POST', { callbackId: action.callbackId, fingerprint: action.fingerprint, answers })); setSubmitted(answers); return true } catch { return false }
  }}/>
}
