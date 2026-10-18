// Dev-only component acceptance page; not an entry in the shipped build.
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageBubble } from '../src/MessageBubble.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'

function Acceptance() {
  const root = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'chat' | 'work'>('chat')
  const [dark, setDark] = useState(false)
  const [stream, setStream] = useState('正在回复')
  const [result, setResult] = useState('尚未操作')
  const gesture = (kind: 'hold' | 'scroll' | 'move' | 'cancel') => {
    setResult('手势处理中')
    const bubble = root.current!.querySelector('.message.assistant .bubble')!
    const rect = bubble.getBoundingClientRect()
    const point = { clientX: rect.left + 20, clientY: Math.max(20, rect.top + 20) }
    bubble.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true, ...point }))
    if (kind === 'scroll') setTimeout(() => root.current!.dispatchEvent(new Event('scroll')), 100)
    if (kind === 'move') bubble.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true, ...point, clientX: point.clientX + 15 }))
    if (kind === 'cancel') bubble.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true }))
    setTimeout(() => {
      bubble.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true }))
      setResult(root.current!.ownerDocument.querySelector('[role="menu"]') ? '菜单已打开' : '菜单已关闭')
    }, 500)
  }
  const text = '好的，我会帮你跟进。\n\n这是一个很长的路径：/Users/example/projects/project-with-a-very-long-name/packages/web/src/components/conversation/MessageBubble.tsx\n\n```typescript\nconst message = "这是很长的一行代码，用来检查横向滚动，而不撑破页面";\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 聊天 | 气泡展示 |\n| 工作 | 保留正文 |'
  return <PulseDesignSystem><header style={{ padding: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}><strong>消息组件验收</strong><button onClick={() => { document.documentElement.dataset.theme = dark ? 'light' : 'dark'; setDark(!dark) }}>切换主题</button><button onClick={() => setMode(mode === 'chat' ? 'work' : 'chat')}>切换展示模式</button><button onClick={() => gesture('hold')}>模拟触摸长按</button><button onClick={() => gesture('scroll')}>模拟长按后滚动</button><button onClick={() => gesture('move')}>模拟手指移动</button><button onClick={() => gesture('cancel')}>模拟取消触摸</button><button onClick={() => setStream(value => value + '，新增流式内容')}>追加流式内容</button><span role="status">{result}</span></header><div ref={root} className="messages" style={{ margin: 'auto', height: 'calc(100dvh - 160px)', overflowY: 'auto' }}>
    <MessageBubble mode={mode} message={{ id: 'user', role: 'user', text: '你好，Pulse', createdAt: '' }} retry={() => {}} onOpenWork={() => {}}/>
    <MessageBubble mode={mode} message={{ id: 'assistant', role: 'assistant', text, createdAt: '' }} retry={() => {}} onOpenWork={() => {}}/>
    <MessageBubble mode={mode} message={{ id: 'short', role: 'assistant', text: '好的', createdAt: '' }} retry={() => {}} onOpenWork={() => {}}/>
    <MessageBubble mode={mode} message={{id:'failed',role:'user',text:'示例失败消息',deliveryState:'failed',requestId:'fixture-request',createdAt:''}} retry={()=>setResult('示例重试已触发')} onOpenWork={()=>{}}/>
    <MessageBubble mode={mode} message={{id:'work',role:'assistant',text:'',work:{conversationId:'fixture-work',title:'检查全部页面和较长的工作卡片标题',state:'pending',progress:'已完成页面检查，等待你查看结果。',laneCount:3},createdAt:''}} retry={()=>{}} onOpenWork={()=>setResult('已打开示例工作')}/>
    <MessageBubble mode={mode} message={{ id: 'stream', role: 'assistant', text: stream, deliveryState: 'replying', createdAt: '' }} retry={() => {}} onOpenWork={() => {}}/>
  </div></PulseDesignSystem>
}
createRoot(document.getElementById('root')!).render(<Acceptance/> )
