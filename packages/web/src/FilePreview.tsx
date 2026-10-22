import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import hljs from 'highlight.js/lib/core'
import { Markdown } from './Markdown.js'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'
import { downloadPreview, fileApi, type PreviewTarget } from './previewState.js'
import { PulseButton } from './PulseControls.js'
const PdfPreview = lazy(() => import('./PdfPreview.js').then(module => ({ default: module.PdfPreview })))
type FileTarget = Extract<PreviewTarget, { kind: 'file' }>

export function FilePreview({ target, transport, onBrowser }: { target: FileTarget; transport: PulseWebTransport; onBrowser: (url: string) => Promise<void> }) {
  const [value, setValue] = useState<{ bytes?: Uint8Array; text?: string; image?: string; type: string; size: number }>(), [error, setError] = useState(''), [source, setSource] = useState(false), [offset, setOffset] = useState(0), [zoom, setZoom] = useState(1), [ticket, setTicket] = useState<{ url: string; browserUrl: string }>(), [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController(); let current = true, image = ''
    setValue(undefined); setTicket(undefined); setError(''); setOffset(0)
    void (async () => {
      const response = await transport.request(fileApi(target, 'raw'), { signal: controller.signal })
      if (!response.ok) {
        const detail = await response.json().catch(() => undefined)
        if (response.status === 404 && detail?.error === 'NOT_FOUND') throw new Error('当前后台尚未支持文件预览接口，请更新并重启开发后台后重试。')
        throw new Error(response.status === 409 ? '文件已发生变化，请重新核对本轮产物。' : response.status === 403 ? '无权读取该文件，请检查当前设备的访问权限。' : '文件不存在、目录不可用或无权读取。')
      }
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!, size = Number(response.headers.get('content-length') ?? 0)
      if (size > 32 * 1024 * 1024) { void response.body?.cancel(); throw new Error('文件超过 32 MiB 预览限制，请下载查看。') }
      const bytes = new Uint8Array(await response.arrayBuffer())
      const extension = target.path.split('.').at(-1)?.toLowerCase() ?? ''
      const textual = type.startsWith('text/') || type === 'application/json' || /^(gd|py|rs|go|java|c|h|cpp|cs|sh|toml|ini|cfg|sql|vue|svelte|tsx|ts|jsx|js)$/.test(extension)
      if (type.startsWith('image/')) image = URL.createObjectURL(new Blob([bytes], { type }))
      if (current) setValue({ bytes, type, size: bytes.length, ...(image ? { image } : {}), ...(textual ? { text: new TextDecoder().decode(bytes) } : {}) })
      if (type === 'text/html') {
        const next = await apiJson<{ url: string; browserUrl: string }>(transport, fileApi(target, 'ticket'), jsonRequest('POST'))
        if (current) setTicket(next)
      }
    })().catch(reason => { if (current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : '文件读取失败。') })
    return () => { current = false; controller.abort(); if (image) URL.revokeObjectURL(image) }
  }, [target, transport, revision])
  const lines = useMemo(() => value?.text?.split('\n') ?? [], [value?.text])
  const page = lines.slice(offset, offset + 1000).join('\n')
  const language = ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', sh: 'bash', html: 'xml', svg: 'xml' } as Record<string, string>)[target.path.split('.').at(-1) ?? ''] ?? target.path.split('.').at(-1) ?? ''
  const highlighted = useMemo(() => page && hljs.getLanguage(language) ? hljs.highlight(page, { language }).value : undefined, [page, language])
  const download = async () => { try { await downloadPreview(await transport.request(fileApi(target, 'raw') + '&download=1'), target.path) } catch { setError('下载失败，请检查文件是否仍存在或已经变化。') } }
  return <section className="file-preview" aria-label={`预览 ${target.path}`}>
    <div className="preview-toolbar"><span className="preview-file-path" title={target.path}>{target.path}</span><PulseButton onClick={() => setRevision(revision + 1)}>刷新</PulseButton><PulseButton onClick={() => void download()}>下载</PulseButton>{value?.text !== undefined && <PulseButton onClick={() => setSource(!source)}>{source ? '预览' : '源码'}</PulseButton>}{ticket && <PulseButton onClick={() => void onBrowser(ticket.browserUrl).catch(() => setError('浏览器打开失败，请检查自动化权限或网络设置。'))}>用浏览器打开</PulseButton>}</div>
    {error ? <p className="preview-error" role="alert">{error}</p> : !value ? <p role="status">正在读取文件…</p> : value.image ? <><div className="preview-toolbar"><PulseButton onClick={() => setZoom(Math.max(.25, zoom - .25))}>缩小</PulseButton><PulseButton onClick={() => setZoom(1)}>适应窗口</PulseButton><PulseButton onClick={() => setZoom(Math.min(4, zoom + .25))}>放大</PulseButton></div><div className="image-preview"><img src={value.image} alt={target.path} style={{ width: `${zoom * 100}%`, maxWidth: zoom === 1 ? '100%' : 'none' }} /></div></> : value.type === 'application/pdf' && value.bytes ? <Suspense fallback={<p>正在加载 PDF…</p>}><PdfPreview bytes={value.bytes} /></Suspense> : value.type === 'text/html' && !source ? ticket ? <iframe title={target.path} src={ticket.url} sandbox="allow-scripts" referrerPolicy="no-referrer" /> : <p>正在准备网页预览…</p> : value.text !== undefined ? <><div className="preview-text">{value.type === 'text/markdown' && !source ? <Markdown text={page} /> : <pre><code dangerouslySetInnerHTML={highlighted ? { __html: highlighted } : undefined}>{highlighted ? undefined : page}</code></pre>}</div>{lines.length > 1000 && <div className="preview-toolbar"><PulseButton disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 1000))}>上一页</PulseButton><span>{offset + 1}–{Math.min(offset + 1000, lines.length)} / {lines.length}</span><PulseButton disabled={offset + 1000 >= lines.length} onClick={() => setOffset(offset + 1000)}>下一页</PulseButton></div>}</> : <p>此格式暂不支持预览（{value.type}，{value.size.toLocaleString()} 字节），可下载查看。</p>}
  </section>
}
