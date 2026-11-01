import { useEffect, useRef, useState } from 'react'
import type { BudgetContinuationView } from '@hunterzhu/pulse-server/protocol'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'
import { PulseButton } from './PulseControls.js'

/** A human grants one new allowance; merely loading or refreshing never renews it. */
export function BudgetContinuationPrompt({ transport, conversationId, revision, running, onContinued }: {
  transport: PulseWebTransport; conversationId: string; revision: string; running: boolean; onContinued: (runId: string) => void
}) {
  const [offer, setOffer] = useState<BudgetContinuationView | null>(null)
  const [dismissed, setDismissed] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('')
  const locked = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let current = true
    setOffer(null); setError('')
    if (!running) void apiJson<BudgetContinuationView | null>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/budget-continuation`)
      .then(value => { if (current && value?.status === 'available' && value.conversationId === conversationId) setOffer(value) }).catch(() => { /* Older servers and unavailable state have no renewal offer. */ })
    return () => { current = false }
  }, [transport, conversationId, revision, running])
  if (!offer || running || dismissed === offer.continuationRunId) return null
  const continueTask = async () => {
    if (locked.current) return
    locked.current = true; setPending(true); setError('')
    try {
      const result = await apiJson<{ runId: string }>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(offer.runId)}/budget-continuation`, jsonRequest('POST', { confirmed: true, expectedUsed: offer.used, expectedLimit: offer.limit }))
      if (alive.current) { setOffer(null); onContinued(result.runId) }
    } catch { if (alive.current) setError('暂时无法确认继续结果，可以安全重试；已有记录会保留。') }
    finally { locked.current = false; if (alive.current) setPending(false) }
  }
  return <section className="run-recovery-card" aria-label="调用额度已用尽">
    <strong>已到本轮调用上限，是否继续？</strong>
    <p>本轮已使用 {offer.used} / {offer.limit} 次，任务累计使用 {offer.totalUsed} 次。继续后获得新一轮 256 次调用，已有改动、检查点和用量记录都会保留；原有 Token 和费用限制仍有效。</p>
    {error && <p role="alert">{error}</p>}
    <div className="run-recovery-actions"><PulseButton type="button" className="primary" disabled={pending} onClick={() => void continueTask()}>{pending ? '正在继续…' : '继续，增加 256 次调用'}</PulseButton><PulseButton type="button" disabled={pending} onClick={() => setDismissed(offer.continuationRunId)}>暂不继续</PulseButton></div>
  </section>
}
