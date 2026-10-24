import type { WebAttachment } from './transport.js'
import { Icon } from './Icon.js'
export function attachmentUrl(item: WebAttachment & { previewUrl?: string | undefined }): string {
  return item.previewUrl || item.url || (item.data ? item.data.startsWith('data:') ? item.data : `data:${item.mediaType};base64,${item.data}` : '')
}
export function AttachmentCards({ items, onRemove, onPreview }: { items: Array<WebAttachment & { previewUrl?: string | undefined }>; onRemove?: ((id: string) => void) | undefined; onPreview?: ((url: string) => void) | undefined }) {
  if (!items.length) return null
  return <div className="attachment-cards">{items.map(item => {
    const url = attachmentUrl(item)
    const body = <>{item.type === 'image' ? <img src={url} alt={item.name} className="attachment-thumbnail" loading="lazy"/> : <span className="attachment-icon"><Icon name="file" size={16}/></span>}<span className="attachment-meta"><span className="attachment-name" title={item.name}>{item.name}</span><span className="attachment-size">{item.size < 1024 ? `${item.size} B` : item.size < 1048576 ? `${(item.size / 1024).toFixed(1)} KB` : `${(item.size / 1048576).toFixed(1)} MB`}</span></span></>
    return <div className="composer-attachment-item" key={item.id}>
      {onRemove ? body : item.type === 'image' ? <button className="attachment-card-open" type="button" aria-label={`预览 ${item.name}`} onClick={() => onPreview?.(url)}>{body}</button> : <a className="attachment-card-open" href={url} download={item.name} target="_blank" rel="noopener noreferrer">{body}</a>}
      {onRemove && <button className="attachment-remove" type="button" aria-label={`移除 ${item.name}`} onClick={() => onRemove(item.id)}>×</button>}
    </div>
  })}</div>
}
