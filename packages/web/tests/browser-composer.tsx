// Isolated acceptance page, excluded from shipped entrypoints and external providers.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { RichComposer, emptyComposerDraft, type ComposerDraft, type ComposerPayload } from '../src/RichComposer.js'
import { MessageBubble } from '../src/MessageBubble.js'
import type { WebMessage } from '../src/transport.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'
const transport = { request: async (path: string) => Response.json(path.includes('skills') ? { skills: [{ id: 'grill-and-plan', name: 'grill-and-plan' }] } : { paths: ['中文目录/a.ts'] }), subscribe: () => () => {} }
function Acceptance() {
  const [key, setKey] = useState('A'), [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({})
  const [messages, setMessages] = useState<Record<string, WebMessage[]>>({})
  const [authorized, setAuthorized] = useState(false), [fail, setFail] = useState(true), [running, setRunning] = useState(false)
  const [result, setResult] = useState('尚未发送')
  const payloadMessage = (payload: ComposerPayload): WebMessage => ({ ...payload, id: `msg-${Date.now()}`, requestId: 'browser-fixture', role: 'user', createdAt: new Date().toISOString(), deliveryState: fail ? 'failed' : 'queued' })
  return <main onDropCapture={event => setResult(`收到拖放：${event.dataTransfer.files.length} 个文件`)} style={{ width: 'min(850px, 100%)', margin: '30px auto', padding: 24, display: 'grid', gap: 18 }}>
    <h1>富文本修复隔离验收</h1>
    <nav style={{ display: 'flex', gap: 10 }}><button onClick={() => setAuthorized(v => !v)}>{authorized ? '撤销示例授权' : '模拟授权成功'}</button><button onClick={() => setKey(v => v === 'A' ? 'B' : 'A')}>切换会话（当前 {key}）</button><button onClick={() => setFail(v => !v)}>{fail ? '切换为发送成功' : '切换为发送失败'}</button><button onClick={() => setRunning(v => !v)}>{running ? '结束示例回复' : '模拟正在回复'}</button></nav>
    <div draggable onDragStart={event => { event.dataTransfer.setData('text/plain', '示例附件拖放'); event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.items.add(new File(['拖放的附件内容'], 'drag-example.txt', { type: 'text/plain' })); setResult(`正在拖动：${event.dataTransfer.items.length} 个文件`) }} style={{ padding: 14, border: '1px dashed #9aa', cursor: 'grab' }}>拖入示例附件</div>
    <div className="messages" style={{ minHeight: 90, maxHeight: 220, overflow: 'auto' }}>{(messages[key] ?? []).map(message => <MessageBubble key={message.id} message={message} mode="chat" retry={() => { setMessages(current => ({ ...current, [key]: (current[key] ?? []).map(item => item.id === message.id ? { ...item, deliveryState: 'queued' } : item) })); setResult('确认后已重发原消息及附件') }} onOpenWork={() => {}} />)}</div>
    <RichComposer key={key} draft={drafts[key] ?? emptyComposerDraft()} onChange={update => setDrafts(current => ({ ...current, [key]: update(current[key] ?? emptyComposerDraft()) }))} transport={transport} surfaceMode="chat" projectId={key} disabled={!authorized} running={running} placeholder={authorized ? '给 Pulse 发送消息…' : '请先授权此设备'} onSend={async payload => { setMessages(current => ({ ...current, [key]: [...(current[key] ?? []), payloadMessage(payload)] })); setResult(`已提交：${payload.text}；附件 ${payload.attachments?.length ?? 0}；技能 ${payload.skills?.join(',') ?? '无'}；文件 ${payload.mentionedFiles?.join(',') ?? '无'}`); return !fail }} />
    <output role="status">{result}</output>
  </main>
}
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><Acceptance /></PulseDesignSystem>)
