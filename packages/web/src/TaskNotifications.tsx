import { useEffect, useRef, useState } from 'react'
import type { PulseWebTransport } from './transport.js'

type Notice = { id: string; kind: 'complete' | 'ask' | 'approval'; conversationId: string; runId: string; groupId?: string; surface?: 'chat' | 'work' }
/** Browser notifications require an explicit gesture. The inbox works without permission. */
export function TaskNotificationInbox({ transport, open }: { transport: PulseWebTransport; open: (path: string) => void }) {
  const [items, setItems] = useState<Notice[]>([]), [expanded, setExpanded] = useState(false)
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const seen = useRef(new Set<string>()), initialized = useRef(false)
  const navigate = (item: Notice) => open(`${item.surface === 'chat' ? '/chat' : '/work/' + encodeURIComponent(item.conversationId)}?notification=${encodeURIComponent(item.groupId ?? item.id)}`)
  useEffect(() => {
    if (window.pulseDesktop) return
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
          if (!closed && permission === 'granted' && (initialized.current || item.kind !== 'complete') && !seen.current.has(item.id)) {
            try {
              const notice = new Notification(item.kind === 'complete' ? 'Pulse · 任务已结束' : 'Pulse · 有待处理事项', { body: '打开 Pulse 查看详情。', tag: item.id })
              notice.onclick = () => { window.focus(); navigate(item); notice.close() }
              shown = true
            } catch { /* System delivery is optional; always update the actionable inbox. */ }
          }
          if (shown || (item.kind === 'complete' && !initialized.current)) seen.current.add(item.id)
        }
        if (!closed) { setItems([...pending, ...feed.filter(item => item.kind === 'complete').slice(-5).reverse()]); initialized.current = true; try { localStorage.setItem('pulse-task-notices', JSON.stringify([...seen.current].slice(-1000))) } catch { /* Inbox remains available. */ } }
      } catch { /* Offline: retain the last known inbox, never submit answers. */ }
      finally { busy = false }
    }
    void sync(); const timer = setInterval(() => void sync(), 5000)
    return () => { closed = true; clearInterval(timer) }
  }, [transport, permission])
  if (window.pulseDesktop) return null
  return <aside aria-label="任务通知" style={{ position: 'relative', zIndex: 80 }}>
    <button type="button" onClick={() => setExpanded(value => !value)}>通知 / 待办（{items.length}）</button>
    {expanded && <div style={{ position: 'absolute', right: 0, top: 38, width: 280, padding: 12, maxWidth: '85vw', maxHeight: 360, overflow: 'auto', background: 'var(--bg, #fff)', color: 'var(--text, #222)', border: '1px solid #999', borderRadius: 8 }}>
      {permission === 'default' && <button type="button" onClick={() => { void Notification.requestPermission().then(setPermission).catch(() => setPermission('denied')) }}>启用系统通知</button>}
      <p>{permission === 'granted' ? '此页面打开时接收通知；点击通知进入任务。' : '系统通知未启用，待办仍保留在这里。'}</p>
      <p>浏览器通知内无法直接作答，请进入任务回答。</p>
      {items.map(item => <button type="button" key={item.id} onClick={() => navigate(item)} style={{ display: 'block', marginTop: 8 }}>{item.kind === 'approval' ? '查看待审批任务' : item.kind === 'complete' ? '查看已结束任务' : '回答待处理问题'}</button>)}
      {!items.length && <p>暂无待处理事项</p>}
    </div>}
  </aside>
}
