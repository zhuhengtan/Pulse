import { useEffect, useRef, useState } from 'react'
import { IndexedMessageQueueStore, MessageQueueController, queueAdapter, readFollowupBehavior, type ConversationQueue, type FollowupBehavior, type QueueAdapter } from './MessageQueue.js'
import { PulseButton } from './PulseControls.js'
import type { PulseWebTransport } from './transport.js'

export function useMessageQueue(transport: PulseWebTransport, scope: string | undefined, enabled: boolean, accepted: NonNullable<QueueAdapter['accepted']>) {
  const [queues, setQueues] = useState<ConversationQueue[]>([])
  const [error, setError] = useState('')
  const [controller, setController] = useState<MessageQueueController>()
  const acceptedRef = useRef(accepted); acceptedRef.current = accepted
  const [behavior, setBehavior] = useState<FollowupBehavior>(readFollowupBehavior)
  useEffect(() => {
    const sync = () => setBehavior(readFollowupBehavior())
    window.addEventListener('storage', sync); window.addEventListener('pulse-followup-change', sync)
    return () => { window.removeEventListener('storage', sync); window.removeEventListener('pulse-followup-change', sync) }
  }, [])
  useEffect(() => {
    if (!scope || !enabled) { setController(undefined); return }
    const current = new MessageQueueController(scope, new IndexedMessageQueueStore(), queueAdapter(transport, (...args) => acceptedRef.current(...args)), setQueues)
    setController(current)
    const tick = () => { void current.tick().catch(() => setError('本地队列缓存不可用，草稿会保留。')) }
    const timer = window.setInterval(tick, 1500)
    const off = transport.onChange?.(tick)
    window.addEventListener('online', tick)
    tick()
    return () => { current.close(); clearInterval(timer); off?.(); window.removeEventListener('online', tick) }
  }, [transport, scope, enabled])
  return { controller, queues, behavior, error }
}

export function MessageQueuePanel({ queue, controller, onError }: { queue: ConversationQueue | undefined; controller: MessageQueueController | undefined; onError: (message: string) => void }) {
  const [editing, setEditing] = useState<string>()
  const [text, setText] = useState('')
  if (!queue?.entries.length || !controller) return null
  const action = (promise: Promise<void>) => { void promise.catch(() => onError('队列操作未保存，原消息已保留。')) }
  return <section className="message-queue" aria-label="待发消息队列">
    <header><strong>待发消息 · {queue.entries.length}{queue.paused ? ' · 已暂停' : ''}</strong><PulseButton onClick={() => action(controller.pause(queue.conversationId, !queue.paused))}>{queue.paused ? '继续队列' : '暂停队列'}</PulseButton></header>
    {queue.error && <p role="status">{queue.error}</p>}
    <ol>{queue.entries.map(entry => <li key={entry.requestId}>
      <details><summary>{entry.sending ? '正在确认发送 · ' : ''}{entry.payload.text.slice(0, 100) || '附件消息'}</summary>
        <p className="queue-message-text">{entry.payload.text}</p>
        {!!entry.payload.attachments?.length && <p>附件：{entry.payload.attachments.map(item => item.name).join('、')}</p>}
        {!!entry.payload.skills?.length && <p>技能：{entry.payload.skills.join('、')}</p>}
        {!!entry.payload.mentionedFiles?.length && <p>引用：{entry.payload.mentionedFiles.join('、')}</p>}
      </details>
      {editing === entry.requestId && <div className="queue-edit"><textarea aria-label="编辑待发消息" value={text} onChange={event => setText(event.target.value)} /><PulseButton onClick={() => { if (text.trim() || entry.payload.attachments?.length) action(controller.edit(queue.conversationId, entry.requestId, text)); setEditing(undefined) }}>保存</PulseButton><PulseButton onClick={() => setEditing(undefined)}>取消</PulseButton></div>}
      <div className="queue-actions"><PulseButton disabled={entry.sending} onClick={() => { setEditing(entry.requestId); setText(entry.payload.text) }}>编辑</PulseButton><PulseButton disabled={entry.sending} onClick={() => action(controller.remove(queue.conversationId, entry.requestId))}>删除</PulseButton><PulseButton disabled={entry.sending} onClick={() => action(controller.sendNow(queue.conversationId, entry.requestId))}>立即发送</PulseButton></div>
    </li>)}</ol>
  </section>
}
