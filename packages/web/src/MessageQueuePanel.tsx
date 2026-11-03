import type { ComposerPayload } from './RichComposer.js'
import { AttachmentCards } from './AttachmentCards.js'
import { RichMessage } from './RichMessage.js'
import { browserTransport } from './transport.js'
import { useEffect, useRef, useState } from 'react'
import { IndexedMessageQueueStore, MessageQueueController, queueAdapter, readFollowupBehavior, type ConversationQueue, type FollowupBehavior, type QueueAdapter } from './MessageQueue.js'
import { Dropdown } from 'antd'
import { Icon } from './Icon.js'
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

export function MessageQueuePanel({ queue, controller, onError, transport = browserTransport, projectId, onEdit, editDisabled }: { onEdit?: ((payload: ComposerPayload) => void) | undefined; editDisabled?: boolean | undefined; transport?: PulseWebTransport; projectId?: string | undefined; queue: ConversationQueue | undefined; controller: MessageQueueController | undefined; onError: (message: string) => void }) {
  const [previewImage, setPreviewImage] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState('')
  const lock = useRef(false)
  if (!queue?.entries.length || !controller) return null
  const action = async (id: string, task: () => Promise<void>, done?: () => void) => {
    if (lock.current) return
    lock.current = true; setPending(id); setError('')
    try { await task(); done?.() }
    catch { const message = '队列操作未保存，原消息已保留。'; setError(message); onError(message) }
    finally { lock.current = false; setPending(undefined) }
  }
  const visible = expanded ? queue.entries : queue.entries.slice(0, 3)
  return <section className="message-queue" aria-label="待发消息队列">
    <header><span>{queue.paused ? '待发消息已暂停' : '待发消息'} <span className="queue-count">{queue.entries.length}</span></span><PulseButton disabled={Boolean(pending)} onClick={() => void action('pause', () => controller.pause(queue.conversationId, !queue.paused))}>{queue.paused ? '继续发送' : '暂停发送'}</PulseButton></header>
    {queue.paused && <p role="status">仅暂停待发消息，正在运行的任务不受影响。</p>}
    {(error || queue.error) && <p role="alert">{error || queue.error}</p>}
    <ol>{visible.map(entry => {
      const busy = entry.sending || Boolean(pending)
      return <li key={entry.requestId} aria-busy={entry.sending || pending === entry.requestId}>
        <div className="queue-row">
          <details className="queue-content"><summary><span className="queue-summary">{entry.payload.text || '附件消息'}</span>{entry.sending && <small role="status">正在确认发送…</small>}{!!entry.payload.attachments?.length && <small>{entry.payload.attachments.length} 个附件</small>}</summary>
            <RichMessage content={entry.payload.richContent} fallback={entry.payload.text}/>
            {!!entry.payload.attachments?.length && <AttachmentCards items={entry.payload.attachments} onPreview={setPreviewImage}/>}
            {!!entry.payload.skills?.length && <p>技能：{entry.payload.skills.join('、')}</p>}
            {!!entry.payload.mentionedFiles?.length && <p>引用：{entry.payload.mentionedFiles.join('、')}</p>}
          </details>
          <div className="queue-actions">
            <PulseButton aria-label="立即发送" title="立即发送" disabled={busy} onClick={() => void action(entry.requestId, () => controller.sendNow(queue.conversationId, entry.requestId))}><Icon name="up" size={16}/></PulseButton>
            <Dropdown trigger={['click']} placement="topRight" menu={{ items: [{ key: 'edit', label: '编辑', disabled: busy || editDisabled || !onEdit }, { key: 'delete', label: '删除', disabled: busy }], onClick: ({ key }) => {
              if (key === 'edit') void action(entry.requestId, async () => { const payload = await controller.takeForEdit(queue.conversationId, entry.requestId); onEdit?.(payload) })
              else void action(entry.requestId, () => controller.remove(queue.conversationId, entry.requestId))
            } }}><PulseButton aria-label="消息操作" title="消息操作" disabled={busy}><Icon name="more" size={16}/></PulseButton></Dropdown>
          </div>
        </div>

      </li>
    })}</ol>
    {previewImage && <div className="attachment-modal-overlay" role="dialog" aria-label="图片预览" onClick={() => setPreviewImage(undefined)}><button type="button" aria-label="关闭预览" onClick={() => setPreviewImage(undefined)}>×</button><img src={previewImage} alt="放大预览" className="attachment-modal-image"/></div>}
    {queue.entries.length > 3 && <PulseButton className="queue-expand" onClick={() => setExpanded(value => !value)}>{expanded ? '收起队列' : `另有 ${queue.entries.length - 3} 条`}<Icon name="down" size={12}/></PulseButton>}
  </section>
}
