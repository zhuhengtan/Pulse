import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { PulseApp } from './RouterApp.js'
import type { PulseWebTransport } from '../src/transport.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'

// Long-history acceptance fixture. All API calls remain in this transport.
const now = new Date().toISOString()
const conversation = { id: 'scroll-work', title: '长工作对话', cwd: '/example', createdAt: now, updatedAt: now }
const history = (kind: string) => Array.from({ length: 80 }, (_, index) => ({ id: `${kind}-${index}`, role: index % 2 ? 'assistant' : 'user', text: index === 79 ? `${kind}最后一条消息` : `${kind}消息 ${index + 1}：${'检查长历史打开时直接显示最新内容。'.repeat(6)}`, createdAt: now }))
const transport: PulseWebTransport = {
  async request(path) {
    let body: unknown = []
    if (path.startsWith('/api/session')) body = { localAdmin: false, canUseTerminal: false }
    else if (path === '/api/assistant') body = { conversation: { ...conversation, id: 'assistant', title: 'Pulse 助理' }, messages: history('聊天'), receipts: [], workInteractions: [] }
    else if (path === '/api/conversations') body = [conversation]
    else if (path.endsWith('/messages')) body = history('工作')
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  },
  subscribe: () => () => {},
}
interface Frame { view: string; top: number; height: number; viewport: number; gap: number }
function Review() {
  const [frames, setFrames] = useState<Frame[]>([])
  useEffect(() => {
    let animation = 0
    const seen = new Set<string>()
    const sample = () => {
      const element = document.querySelector<HTMLElement>('.messages')
      const title = document.querySelector('.navbar-title')?.textContent ?? ''
      const mode = document.querySelector('.surface-switch [aria-selected="true"]')?.textContent ?? ''
      const view = `${mode}：${title}`
      if (element?.querySelector('.message') && !element.querySelector('.empty .spinner') && !seen.has(view)) {
        seen.add(view)
        setFrames(current => [...current, { view, top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight, gap: element.scrollHeight - element.scrollTop - element.clientHeight }])
      }
      animation = requestAnimationFrame(sample)
    }
    animation = requestAnimationFrame(sample)
    return () => cancelAnimationFrame(animation)
  }, [])
  return <PulseDesignSystem><header style={{ height: 36, display: 'flex', alignItems: 'center', padding: '0 12px', gap: 12 }}><span>长历史滚动验收 · 独立测试数据</span><output aria-label="首帧底部距离">{frames.map(frame => `${frame.view}：${frame.gap}`).join('；')}</output><pre hidden id="first-frames">{JSON.stringify(frames)}</pre></header><div style={{ height: 'calc(100dvh - 36px)' }}><PulseApp transport={transport}/></div></PulseDesignSystem>
}
createRoot(document.getElementById('root')!).render(<Review/> )
