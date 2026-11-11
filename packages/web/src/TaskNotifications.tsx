import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon.js'
import type { PulseWebTransport } from './transport.js'

type Notice = { revision?: string; readAt?: number; id: string; kind: 'complete' | 'ask' | 'approval'; conversationId: string; runId: string; groupId?: string; surface?: 'chat' | 'work' }
type NoticeBox = { top: number; left: number; width: number }
/** Keep the menu inside the viewport. A right-anchored 280px panel overflows when the toggle sits near the left edge. */
function noticeBox(anchor: DOMRect): NoticeBox {
  const margin = 8
  const width = Math.min(280, Math.max(0, window.innerWidth - margin * 2))
  const left = Math.min(Math.max(anchor.right - width, margin), Math.max(margin, window.innerWidth - margin - width))
  const top = Math.min(Math.max(margin, anchor.bottom + 6), Math.max(margin, window.innerHeight - margin - 48))
  return { top, left, width }
}

/** Browser notifications require an explicit gesture. The inbox works without permission. */
export function TaskNotificationInbox({ transport, open }: { transport: PulseWebTransport; open: (path: string) => void }) {
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<Notice[]>([]), [expanded, setExpanded] = useState(() => new URLSearchParams(window.location.search).get('notices') === '1')
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const [box, setBox] = useState<NoticeBox>()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const seen = useRef(new Set<string>()), initialized = useRef(false)
  const navigate = (item: Notice) => open(`${item.surface === 'chat' ? '/chat' : '/work/' + encodeURIComponent(item.conversationId)}?notification=${encodeURIComponent(item.groupId ?? item.id)}${item.revision ? '&noticeRevision=' + encodeURIComponent(item.revision) : ''}&noticeRun=${encodeURIComponent(item.runId)}`)
  useEffect(() => {
    let closed = false, busy = false
    try { seen.current = new Set(JSON.parse(localStorage.getItem('pulse-task-notices') ?? '[]')) } catch { /* Optional notification cache. */ }
    const sync = async () => {
      if (busy) return; busy = true
      try {
        const response = await transport.request('/api/notifications'); if (!response.ok) return
        const feed = await response.json() as Notice[]
        const pending: Notice[] = [], snapshots = new Map<string, { state: string; interactions?: Array<{ groupId: string }> }>()
        const completed = new Set(feed.filter(item => item.kind === 'complete').map(item => item.runId))
        for (const item of feed) {
          if (item.kind !== 'complete') {
            if (completed.has(item.runId)) continue
            if (!snapshots.has(item.runId)) { const state = await transport.request(`/api/runs/${encodeURIComponent(item.runId)}/state`); if (!state.ok) continue; snapshots.set(item.runId, await state.json()) }
            const snapshot = snapshots.get(item.runId)!
            if (snapshot.state !== 'running' || !snapshot.interactions?.some(group => group.groupId === item.groupId)) continue
            pending.push(item)
          }
          let shown = false
          if (!closed && !window.pulseDesktop && permission === 'granted' && (initialized.current || item.kind !== 'complete') && !seen.current.has(item.id)) {
            try {
              const notice = new Notification(item.kind === 'complete' ? 'Pulse · 任务已结束' : 'Pulse · 有待处理事项', { body: '打开 Pulse 查看详情。', tag: item.id })
              notice.onclick = () => { window.focus(); navigate(item); notice.close() }
              shown = true
            } catch { /* System delivery is optional; always update the actionable inbox. */ }
          }
          if (shown || (item.kind === 'complete' && !initialized.current)) seen.current.add(item.id)
        }
        if (!closed) { setUnread(feed.filter(item => !item.readAt && (item.kind === 'complete' || pending.some(current => current.id === item.id))).length); setItems([...pending, ...feed.filter((item, index) => item.kind === 'complete' && (!item.readAt || index >= feed.length - 5)).reverse()]); initialized.current = true; try { localStorage.setItem('pulse-task-notices', JSON.stringify([...seen.current].slice(-1000))) } catch { /* Inbox remains available. */ } }
      } catch { /* Offline: retain the last known inbox, never submit answers. */ }
      finally { busy = false }
    }
    void sync(); const timer = setInterval(() => void sync(), 5000)
    return () => { closed = true; clearInterval(timer) }
  }, [transport, permission])
  useLayoutEffect(() => {
    if (!expanded) return
    const place = () => { const anchor = toggleRef.current?.getBoundingClientRect(); if (anchor) setBox(noticeBox(anchor)) }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [expanded])
  return <aside className="task-notice" aria-label="任务通知">
    <button ref={toggleRef} type="button" className="task-notice-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="task-notice-full">通知 / 待办（{unread} 未读）</span>
      <span className="task-notice-compact" aria-hidden="true"><Icon name="archive" size={16}/><span className="task-notice-count">{unread > 0 ? '●' : ''}</span></span>
    </button>
    {expanded && <div className="task-notice-panel" role="region" aria-label="待办列表" style={box ? { top: box.top, left: box.left, width: box.width, right: 'auto' } : undefined}>
      {!window.pulseDesktop && permission === 'default' && <button type="button" className="task-notice-action" onClick={() => { void Notification.requestPermission().then(setPermission).catch(() => setPermission('denied')) }}>启用系统通知</button>}
      <p>{permission === 'granted' ? '此页面打开时接收通知；点击通知进入任务。' : '系统通知未启用，待办仍保留在这里。'}</p>
      <p>阅读后清除红点；未回答的问题和审批仍保留在待办。</p>
      {items.map(item => <button type="button" className="task-notice-action" key={item.id} onClick={() => navigate(item)}>{item.kind === 'approval' ? '查看待审批任务' : item.kind === 'complete' ? '查看已结束任务' : '回答待处理问题'}</button>)}
      {!items.length && <p>暂无待处理事项</p>}
    </div>}
  </aside>
}
