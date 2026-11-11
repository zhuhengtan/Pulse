import { useEffect, useState } from 'react'
import type { PendingInteraction } from './InteractionPanel.js'
import { PulseButton } from './PulseControls.js'

export const interactionKey = (item: Pick<PendingInteraction, 'runId' | 'groupId'>) => `${item.runId}:${item.groupId}`
export const interactionElementId = (item: Pick<PendingInteraction, 'runId' | 'groupId'>) => `pending-work-${encodeURIComponent(interactionKey(item))}`
export function PendingWorkSummary({ items, onLocate }: { items: PendingInteraction[]; onLocate: (item: PendingInteraction) => void }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!items.length) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [items.length])
  if (!items.length) return null
  return <aside className="pending-work-summary" aria-label="待处理事项">
    {items.map(item => {
      const minutes = item.requestedAt === undefined ? undefined : Math.max(0, Math.floor((now - item.requestedAt) / 60_000))
      return <PulseButton key={interactionKey(item)} onClick={() => onLocate(item)} aria-label={`查看${item.interactionKind === 'approval' ? '待审批操作' : '待回答问题'}：${item.conversationTitle ?? '当前对话'}`}>
        <span>{item.interactionKind === 'approval' ? '等待你审批' : '等待你回答'}{minutes === undefined ? '' : minutes < 1 ? ' · 刚刚' : ` · 已等待 ${minutes} 分钟`}</span>
        <span className="pending-work-title">{item.conversationTitle ?? '当前对话'}</span><span>查看事项</span>
      </PulseButton>
    })}
  </aside>
}
