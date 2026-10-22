import { PulseButton, usePulseDialogs } from './PulseControls.js'
import { memo, useEffect, useRef, useState } from 'react'
import { Popover } from 'antd-mobile'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'
import { copyText } from './clipboard.js'
import { useMessageActions } from './useMessageActions.js'
import { apiJson, browserTransport, type WebMessage, type PulseWebTransport } from './transport.js'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const MessageBubble = memo(function MessageBubble({ message, mode, retry, onOpenWork, onFileClick, onDiffClick, transport = browserTransport, conversationId }: {
  message: WebMessage
  mode: 'chat' | 'work'
  retry: (message: WebMessage, mode: 'chat' | 'work') => void
  transport?: PulseWebTransport
  conversationId?: string | undefined
  onOpenWork: (conversationId: string) => void
  onFileClick?: ((path: string) => void) | undefined
  onDiffClick?: ((path: string) => void) | undefined
}) {
  const [fullText, setFullText] = useState<string>()
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyError, setBodyError] = useState('')
  const text = fullText ?? message.text
  const loadBody = async () => {
    if (bodyLoading) return
    setBodyLoading(true); setBodyError('')
    try { const body = await apiJson<WebMessage>(transport, `/api/data/conversations/${encodeURIComponent(messageConversationId())}/body?id=${encodeURIComponent(message.id)}`); setFullText(body.text) }
    catch { setBodyError('正文暂时无法加载，请重试。') }
    finally { setBodyLoading(false) }
  }
  const messageConversationId = () => conversationId ?? ''
  const dialogs = usePulseDialogs()
  const retryInFlight = useRef(false)
  const confirmRetry = async () => {
    if (retryInFlight.current) return
    retryInFlight.current = true
    try { if (await dialogs.confirm('重新发送这条消息及其附件？')) retry(message, mode) }
    finally { retryInFlight.current = false }
  }
  const actions = useMessageActions(`${mode}:${message.id}`)
  const [feedback, setFeedback] = useState('')
  const [copying, setCopying] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const copyInFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(feedbackTimer.current) } }, [])
  const copy = async () => {
    if (copyInFlight.current) return
    copyInFlight.current = true
    setCopying(true)
    try { const content = message.bodyTruncated && fullText === undefined ? (await apiJson<WebMessage>(transport, `/api/data/conversations/${encodeURIComponent(messageConversationId())}/body?id=${encodeURIComponent(message.id)}`)).text : text; await copyText(content); if (mounted.current) setFeedback('已复制') }
    catch { if (mounted.current) setFeedback('复制失败，请重试或手动选择文字') }
    finally {
      copyInFlight.current = false
      if (mounted.current) {
        setCopying(false)
        actions.close()
        clearTimeout(feedbackTimer.current)
        feedbackTimer.current = setTimeout(() => setFeedback(''), 2200)
      }
    }
  }
  const sentAt = new Date(message.createdAt)
  const validTime = Number.isFinite(sentAt.getTime())
  const timeLabel = validTime ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(sentAt).replaceAll('/', '-') : ''
  const timeTitle = validTime ? `${sentAt.toLocaleString('zh-CN', { hour12: false })}（本地时间）` : ''
  const copyLabel = message.role === 'user' ? '复制消息' : '复制回复'

  const hasContent = Boolean(message.text.trim()) || Boolean(message.attachments?.length)
  const canRetry = (message.deliveryState === 'failed' || message.deliveryState === 'interrupted') && Boolean(message.requestId)
  const images = (message.attachments || []).filter(att => att.type === 'image')
  const files = (message.attachments || []).filter(att => att.type === 'file')

  return <article className={`message message--${mode} ${message.role === 'user' ? 'user' : 'assistant'}`} tabIndex={hasContent ? 0 : undefined} aria-label={message.role === 'user' ? '你的消息' : 'Pulse 消息'} onKeyDown={event => { if (hasContent && event.target === event.currentTarget && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) { event.preventDefault(); actions.setAnchor({ x: 16, y: 12 }); actions.open() } }}>
    {(hasContent || canRetry) && <div className="message-bubble-row">
      {canRetry && <button type="button" className="message-retry" aria-label="发送失败，重新发送" title="发送失败，点击确认重新发送" onClick={() => void confirmRetry()}>!</button>}
      {hasContent && <div className={`bubble ${actions.menuOpen ? 'has-message-menu' : ''}`} {...actions.gesture}>
        {message.text.trim() && <Markdown text={text} onFileClick={onFileClick} onDiffClick={onDiffClick} />}
        {message.bodyTruncated && fullText === undefined && <div><PulseButton onClick={() => void loadBody()} disabled={bodyLoading}>{bodyLoading ? '加载中…' : '展开完整消息'}</PulseButton>{bodyError && <span role="alert">{bodyError}</span>}</div>}
        {images.length > 0 && (
          <div className="message-attachments-grid">
            {images.map(img => {
              const src = img.url || (img.data ? (img.data.startsWith('data:') ? img.data : `data:${img.mediaType};base64,${img.data}`) : '')
              return (
                <div key={img.id} className="message-image-attachment" onClick={() => setPreviewImage(src)}>
                  <img src={src} alt={img.name} loading="lazy" />
                </div>
              )
            })}
          </div>
        )}
        {files.length > 0 && (
          <div className="message-attachments-grid">
            {files.map(file => {
              const href = file.url || (file.data ? (file.data.startsWith('data:') ? file.data : `data:${file.mediaType};base64,${file.data}`) : '#')
              return (
                <a key={file.id} href={href} download={file.name} className="message-file-card" target="_blank" rel="noopener noreferrer">
                  <span className="file-icon">📄</span>
                  <div className="file-info">
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">{file.size ? formatFileSize(file.size) : file.mediaType}</span>
                  </div>
                </a>
              )
            })}
          </div>
        )}
        <Popover trigger="click" visible={actions.menuOpen} onVisibleChange={actions.setMenuOpen} destroyOnHide placement={message.role === 'user' ? 'top-end' : 'top-start'} className="message-mobile-popover" content={<div>{validTime && <time className="message-menu-time" dateTime={sentAt.toISOString()} title={timeTitle}>{timeLabel}</time>}<div role="menu" aria-label="消息操作"><PulseButton type="button" role="menuitem" disabled={copying} onClick={() => void copy()}><Icon name="copy"/><span>复制</span></PulseButton></div></div>}>
          <span className="message-menu-anchor" aria-hidden="true" style={{ left: actions.anchor.x, top: actions.anchor.y }}/>
        </Popover>
      </div>}
    </div>}
    {previewImage && (
      <div className="attachment-modal-overlay" onClick={() => setPreviewImage(null)}>
        <img src={previewImage} alt="放大预览" className="attachment-modal-image" />
      </div>
    )}
    {message.deliveryState && <div className={`delivery-state ${message.deliveryState}`}><span>{message.deliveryState === 'queued' ? '排队中' : message.deliveryState === 'replying' ? '正在回复' : message.deliveryState === 'interrupted' ? '回复中断' : '发送失败'}</span></div>}
    {message.work && <PulseButton type="button" className={`work-message-card ${message.work.state}`} onClick={() => onOpenWork(message.work!.conversationId)}><span className="work-message-icon"><Icon name="folder"/></span><span><strong>{message.work.title}</strong><small>{workCardStatus(message.work.state)} · 查看工作会话</small>{message.work.progress && <small className="work-progress">{message.work.progress}</small>}{typeof message.work.laneCount === 'number' && <small>{message.work.laneCount} 条执行 Lane</small>}</span><Icon name="chevron"/></PulseButton>}
    {hasContent && <div className="message-footer"><PulseButton type="button" className="message-copy-action" aria-label={copyLabel} title={copyLabel} disabled={copying} onClick={() => void copy()}><Icon name="copy" size={15}/></PulseButton>{validTime && <time className="message-time" dateTime={sentAt.toISOString()} title={timeTitle} aria-label="发送时间">{timeLabel}</time>}<span className="message-feedback" role="status">{feedback}</span>{message.restored && <small>已从归档恢复答案</small>}{message.legacy && <small>旧版记录</small>}</div>}
  </article>
})

function workCardStatus(state: NonNullable<WebMessage['work']>['state']): string {
  return state === 'running' ? '后台执行中' : state === 'waiting' ? '等待你处理交互' : state === 'succeeded' ? '工作已完成并合入' : state === 'cancelled' ? '工作已停止' : state === 'interrupted' ? '工作已中断' : state === 'conflict' ? '项目有冲突，工作结果已保留' : state === 'pending' ? '结果待验收，尚未合入' : '工作未完成'
}
