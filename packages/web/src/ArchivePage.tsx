import { useEffect, useState } from 'react'
import { ApiError, apiJson, jsonRequest } from './transport.js'
import { Icon } from './Icon.js'
import type { PulseWebTransport, WebConversation } from './transport.js'

export function ArchivePage({ transport, onBack, onChanged, onOpen }: { transport: PulseWebTransport; onBack: () => void; onChanged: () => void; onOpen: (conversation: WebConversation) => void }) {
  const [items, setItems] = useState<WebConversation[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refresh = async () => {
    setLoading(true); setError('')
    try { setItems(await apiJson<WebConversation[]>(transport, '/api/conversations?archived=1')) }
    catch (reason) { setError(reason instanceof ApiError && reason.status === 401 ? '登录状态已失效，请返回聊天后重新授权。' : '归档列表暂时无法加载。') }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [transport])
  const filtered = items.filter(item => `${item.title} ${item.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const restore = async (item: WebConversation) => {
    try { const updated = await apiJson<WebConversation>(transport, `/api/conversations/${encodeURIComponent(item.id)}`, jsonRequest('PATCH', { archived: false })); setItems(all => all.filter(value => value.id !== item.id)); onChanged(); onOpen(updated) }
    catch { setError('恢复失败；对话仍保留在归档中。') }
  }
  const remove = async (item: WebConversation) => {
    if (!window.confirm(`永久删除“${item.title}”？此操作无法撤销。`)) return
    try { await apiJson(transport, `/api/conversations/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); setItems(all => all.filter(value => value.id !== item.id)); onChanged() }
    catch { setError('删除失败；任务仍可能处于待恢复状态。') }
  }
  return <main className="archive-shell"><header className="archive-header"><button className="icon-button" onClick={onBack} aria-label="返回聊天"><Icon name="back"/></button><div><h1>归档对话</h1><p>归档内容可以恢复；永久删除不可撤销。</p></div></header><label className="archive-search"><Icon name="search"/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索对话或工作目录" /></label>{error && <p className="settings-alert" role="alert">{error}<button onClick={() => void refresh()}>重试</button></p>}<section className="archive-list">{loading ? <p>正在加载归档…</p> : filtered.length ? filtered.map(item => <article className="archive-item" key={item.id}><button className="archive-title" onClick={() => onOpen(item)}><strong>{item.title || '新对话'}</strong><small>{item.cwd}</small></button><button onClick={() => void restore(item)}>恢复</button><button className="danger" onClick={() => void remove(item)}>删除</button></article>) : <p>{query ? '没有匹配的归档对话。' : '还没有归档对话。'}</p>}</section></main>
}
