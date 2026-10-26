import { useEffect, useRef, useState } from 'react'
import { InteractionPanel, type PendingInteraction } from './InteractionPanel.js'
import { PulseButton } from './PulseControls.js'
import { PulseBrand } from './PulseBrand.js'
import './chat-surface.css'
import './question-dialog.css'
type Answers = Array<{ effectId: string; value: Record<string, unknown> }>
export type QuestionState = { status: 'expired' | 'submitted' } | { status: 'ready'; fingerprint: string; interaction: PendingInteraction }
export interface QuestionBridge { state(): Promise<QuestionState>; submit(answers: Answers): Promise<boolean>; openFull(): Promise<void>; close(): Promise<void> }
declare global { interface Window { pulseQuestion?: QuestionBridge } }
export function QuestionDialog({ bridge = window.pulseQuestion }: { bridge?: QuestionBridge | undefined }) {
  const [state, setState] = useState<QuestionState>(), [error, setError] = useState('')
  const committed = useRef(false), active = useRef(true)
  useEffect(() => {
    active.current = true
    if (!bridge) return
    let busy = false
    const refresh = async () => {
      if (busy || committed.current) return
      busy = true
      try { const next = await bridge.state(); if (active.current && !committed.current) { setState(next); setError('') } }
      catch { if (active.current && !committed.current) setError('暂时无法连接后台，请保持窗口打开，连接恢复后可继续。') }
      finally { busy = false }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 1500)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') void bridge.close() }
    window.addEventListener('keydown', key)
    return () => { active.current = false; window.clearInterval(timer); window.removeEventListener('keydown', key) }
  }, [bridge])
  const submit = async (answers: Answers) => {
    if (!bridge || state?.status !== 'ready' || committed.current) return false
    // Refresh before submitting; the main process independently checks the exact target again.
    const fresh = await bridge.state()
    if (fresh.status !== 'ready' || fresh.fingerprint !== state.fingerprint) { setState({ status: 'expired' }); return false }
    const ok = await bridge.submit(answers)
    if (ok && active.current) { committed.current = true; setState({ status: 'submitted' }) }
    return ok
  }
  const query = new URLSearchParams(window.location.search)
  const fallback = `${query.get('surface') === 'chat' ? '/chat' : '/work/' + encodeURIComponent(query.get('conversation') ?? '')}?notification=${encodeURIComponent(query.get('group') ?? '')}`
  return <main className="question-dialog">
    <header className="question-dialog-header"><PulseBrand/><span>回答问题</span></header>
    {!bridge ? <section role="status"><p>请在任务页面查看并回答这个问题。</p><a href={fallback}>打开对应任务</a></section>
      : <>
      {error ? <p role="alert">{error}</p> : state?.status === 'ready' ? <InteractionPanel key={`${state.interaction.runId}:${state.interaction.groupId}:${state.fingerprint}`} interaction={state.interaction} notificationTarget={state.interaction.groupId} draftScope={state.fingerprint} reviewNote="" delegated={false} submit={submit} onDismiss={() => { void bridge.close() }}/>
        : <p role="status">{state?.status === 'submitted' ? '回答已提交。' : state?.status === 'expired' ? '这个问题已回答、已取消或已变更。不会将答案发给其他问题。' : '正在读取问题…'}</p>}
      <footer><PulseButton onClick={() => { void bridge.openFull() }}>打开完整会话</PulseButton><PulseButton onClick={() => { void bridge.close() }}>关闭窗口</PulseButton></footer>
      </>}
  </main>
}
