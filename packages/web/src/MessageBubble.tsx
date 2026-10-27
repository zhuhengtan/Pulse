import { AttachmentCards } from './AttachmentCards.js'
import { RichMessage } from './RichMessage.js'
import { PulseButton, usePulseDialogs } from './PulseControls.js'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Popover } from 'antd-mobile'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'
import { copyText } from './clipboard.js'
import { useMessageActions } from './useMessageActions.js'
import { contentHash } from './content-hash.js'
import { apiJson, browserTransport, type WebMessage, type PulseWebTransport } from './transport.js'
// Reuse ICU formatters across the visible message window and route switches.
const messageTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const messageTimeTitle = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false })
type BodyIdentity = { conversationId: string; id: string; bodyHash?: string; text: string; bodyLength?: number; bodyTruncated: boolean }
const bodyVersion = (identity: BodyIdentity) => identity.bodyHash ? `${identity.conversationId}\0${identity.id}\0${identity.bodyHash}` : `${identity.conversationId}\0${identity.id}\0${identity.text}\0${identity.bodyLength ?? ''}\0${identity.bodyTruncated ? 1 : 0}`
const sameBody = (left: BodyIdentity, right: BodyIdentity) => bodyVersion(left) === bodyVersion(right)

export const MessageBubble = memo(function MessageBubble({ message, mode, retry, imageApi, onOpenWork, onFileClick, onDiffClick, transport = browserTransport, conversationId }: {
  message: WebMessage
  imageApi?: ((source: string, runId?: string) => string | undefined) | undefined
  mode: 'chat' | 'work'
  retry: (message: WebMessage, mode: 'chat' | 'work') => void
  transport?: PulseWebTransport
  conversationId?: string | undefined
  onOpenWork: (conversationId: string) => void
  onFileClick?: ((path: string, runId?: string) => void) | undefined
  onDiffClick?: ((path: string) => void) | undefined
}) {
  const identity: BodyIdentity = { conversationId: conversationId ?? '', id: message.id, ...(message.bodyHash ? { bodyHash: message.bodyHash } : {}), text: message.text, ...(message.bodyLength === undefined ? {} : { bodyLength: message.bodyLength }), bodyTruncated: message.bodyTruncated === true }
  const version = bodyVersion(identity)
  const versionRef = useRef(identity)
  versionRef.current = identity
  const requestSerial = useRef(0)
  const [shownVersion, setShownVersion] = useState(version)
  const [expandedText, setExpandedText] = useState<string>()
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyError, setBodyError] = useState('')
  const wantsFull = useRef(false)
  const staleVersion = shownVersion !== version
  if (staleVersion) { setShownVersion(version); setExpandedText(undefined) }
  const text = !staleVersion && expandedText !== undefined ? expandedText : message.text
  const scopedImageApi = useCallback((source: string) => imageApi?.(source, message.runId), [imageApi, message.runId])
  const scopedFileClick = useCallback((path: string) => onFileClick?.(path, message.runId), [onFileClick, message.runId])
  const readMatchingBody = useCallback(async (requested: BodyIdentity) => {
    const body = await apiJson<WebMessage>(transport, `/api/data/conversations/${encodeURIComponent(requested.conversationId)}/body?id=${encodeURIComponent(requested.id)}`)
    if (!sameBody(requested, versionRef.current)) return undefined
    const full = typeof body.text === 'string' ? body.text : ''
    const current = versionRef.current
    if (current.bodyHash) {
      const digest = await contentHash(full)
      const live = versionRef.current
      if (!sameBody(requested, live) || digest !== live.bodyHash || (body.bodyHash !== undefined && body.bodyHash !== live.bodyHash)) return undefined
    }
    return full
  }, [transport])
  const loadBody = async () => {
    if (bodyLoading) return
    wantsFull.current = true
    const requested = versionRef.current
    const serial = ++requestSerial.current
    setBodyLoading(true); setBodyError('')
    try {
      const full = await readMatchingBody(requested)
      if (serial !== requestSerial.current) return
      if (full === undefined) { setBodyError('正文暂时无法加载，请重试。'); return }
      setExpandedText(full)
    } catch { if (serial === requestSerial.current) setBodyError('正文暂时无法加载，请重试。') }
    finally { if (serial === requestSerial.current) setBodyLoading(false) }
  }
  useEffect(() => {
    if (!wantsFull.current || expandedText !== undefined || !message.bodyTruncated) return
    const requested = versionRef.current
    const serial = ++requestSerial.current
    let cancelled = false
    setBodyLoading(true); setBodyError('')
    void readMatchingBody(requested).then(full => {
      if (cancelled || serial !== requestSerial.current) return
      if (full === undefined) { setBodyError('正文暂时无法加载，请重试。'); return }
      setExpandedText(full)
    }).catch(() => { if (!cancelled && serial === requestSerial.current) setBodyError('正文暂时无法加载，请重试。') }).finally(() => { if (!cancelled && serial === requestSerial.current) setBodyLoading(false) })
    return () => { cancelled = true }
  }, [version, expandedText, message.bodyTruncated, readMatchingBody])
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
    try {
      const requested = versionRef.current
      const content = message.bodyTruncated && (staleVersion || expandedText === undefined) ? await readMatchingBody(requested) : text
      if (content === undefined || !sameBody(requested, versionRef.current)) throw new Error('stale body')
      await copyText(content); if (mounted.current) setFeedback('已复制')
    }
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
  const sentAt = useMemo(() => new Date(message.createdAt), [message.createdAt])
  const validTime = Number.isFinite(sentAt.getTime())
  const timeLabel = useMemo(() => validTime ? messageTime.format(sentAt).replaceAll('/', '-') : '', [sentAt, validTime])
  const timeTitle = useMemo(() => validTime ? `${messageTimeTitle.format(sentAt)}（本地时间）` : '', [sentAt, validTime])
  const copyLabel = message.role === 'user' ? '复制消息' : '复制回复'

  const hasContent = Boolean(message.text.trim()) || Boolean(message.attachments?.length)
  const canRetry = (message.deliveryState === 'failed' || message.deliveryState === 'interrupted') && Boolean(message.requestId)

  return <article className={`message message--${mode} ${message.role === 'user' ? 'user' : 'assistant'}`} tabIndex={hasContent ? 0 : undefined} aria-label={message.role === 'user' ? '你的消息' : 'Pulse 消息'} onKeyDown={event => { if (hasContent && event.target === event.currentTarget && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) { event.preventDefault(); actions.setAnchor({ x: 16, y: 12 }); actions.open() } }}>
    {(hasContent || canRetry) && <div className="message-bubble-row">
      {canRetry && <button type="button" className="message-retry" aria-label="发送失败，重新发送" title="发送失败，点击确认重新发送" onClick={() => void confirmRetry()}>!</button>}
      {hasContent && <div className={`bubble ${actions.menuOpen ? 'has-message-menu' : ''}`} {...actions.gesture}>
        {message.role === 'user' && <AttachmentCards items={message.attachments ?? []} onPreview={setPreviewImage}/>}
        {message.text.trim() && (message.role === 'user' ? <RichMessage content={message.richContent} fallback={text} onFileClick={onFileClick ? scopedFileClick : undefined} onDiffClick={onDiffClick}/> : <Markdown text={text} imageApi={imageApi ? scopedImageApi : undefined} transport={transport} onFileClick={onFileClick ? scopedFileClick : undefined} onDiffClick={onDiffClick} />)}
        {message.bodyTruncated && expandedText === undefined && <div><PulseButton onClick={() => void loadBody()} disabled={bodyLoading}>{bodyLoading ? '加载中…' : '展开完整消息'}</PulseButton>{bodyError && <span role="alert">{bodyError}</span>}</div>}
        {message.role !== 'user' && <AttachmentCards items={message.attachments ?? []} onPreview={setPreviewImage}/>}

        {actions.menuOpen && <Popover trigger="click" visible onVisibleChange={actions.setMenuOpen} destroyOnHide placement={message.role === 'user' ? 'top-end' : 'top-start'} className="message-mobile-popover" content={<div>{validTime && <time className="message-menu-time" dateTime={sentAt.toISOString()} title={timeTitle}>{timeLabel}</time>}<div role="menu" aria-label="消息操作"><PulseButton type="button" role="menuitem" disabled={copying} onClick={() => void copy()}><Icon name="copy"/><span>复制</span></PulseButton></div></div>}>
          <span className="message-menu-anchor" aria-hidden="true" style={{ left: actions.anchor.x, top: actions.anchor.y }}/>
        </Popover>}
      </div>}
    </div>}
    {previewImage && (
      <div className="attachment-modal-overlay" onClick={() => setPreviewImage(null)}>
        <img src={previewImage} alt="放大预览" className="attachment-modal-image" />
      </div>
    )}
    {message.deliveryState && <div className={`delivery-state ${message.deliveryState}`}><span>{message.deliveryState === 'queued' ? '排队中' : message.deliveryState === 'replying' ? '正在回复' : message.deliveryState === 'interrupted' ? '回复中断' : '发送失败'}</span></div>}
    {message.work && <PulseButton type="button" className={`work-message-card ${message.work.state}`} onClick={() => onOpenWork(message.work!.conversationId)}><span className="work-message-icon"><Icon name="folder"/></span><span><strong>{message.work.title}</strong><small>{workCardStatus(message.work.state)} · 查看工作会话</small>{message.work.progress && <small className="work-progress">{message.work.progress}</small>}{typeof message.work.laneCount === 'number' && <small>{message.work.laneCount} 条执行 Lane</small>}</span><Icon name="chevron"/></PulseButton>}
    {hasContent && <div className="message-footer"><button type="button" className="pulse-button message-copy-action" aria-label={copyLabel} title={copyLabel} disabled={copying} onClick={() => void copy()}><Icon name="copy" size={15}/></button>{validTime && <time className="message-time" dateTime={sentAt.toISOString()} title={timeTitle} aria-label="发送时间">{timeLabel}</time>}<span className="message-feedback" role="status">{feedback}</span>{message.restored && <small>已从归档恢复答案</small>}{message.legacy && <small>旧版记录</small>}</div>}
  </article>
})

function workCardStatus(state: NonNullable<WebMessage['work']>['state']): string {
  return state === 'running' ? '后台执行中' : state === 'waiting' ? '等待你处理交互' : state === 'succeeded' ? '工作已完成并合入' : state === 'cancelled' ? '工作已停止' : state === 'interrupted' ? '工作已中断' : state === 'conflict' ? '项目有冲突，工作结果已保留' : state === 'pending' ? '结果待验收，尚未合入' : '工作未完成'
}
