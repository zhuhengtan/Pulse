import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { PulseWebTransport } from './transport.js'
import { PulseButton } from './PulseControls.js'
import { memo, useEffect, useState, Children, isValidElement, type ReactNode, type ReactElement } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import html from 'highlight.js/lib/languages/xml'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import 'highlight.js/styles/github-dark.css'
import { copyText } from './clipboard.js'

for (const [name, language] of Object.entries({ bash, sh: bash, css, html, xml: html, javascript, js: javascript, json, markdown, md: markdown, python, py: python, typescript, ts: typescript, tsx: typescript })) hljs.registerLanguage(name, language)

/** Use CommonMark positions so nested/indented/fenced/inline code is never rewritten. */
const mathBoundaryParser = unified().use(remarkParse)
export function normalizeMathDelimiters(source: string): string {
  if (!source.includes('\\(') && !source.includes('\\[')) return source
  const protectedRanges: Array<[number, number]> = []
  type BoundaryNode = { type: string; position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined; children?: BoundaryNode[] | undefined }
  const walk = (node: BoundaryNode) => {
    if (['code', 'inlineCode', 'html'].includes(node.type) && node.position) {
      protectedRanges.push([node.position.start.offset!, node.position.end.offset!]); return
    }
    node.children?.forEach(walk)
  }
  walk(mathBoundaryParser.parse(source))
  const convert = (value: string) => value.replace(/(?<!\\)\\\(([\s\S]*?)\\\)|(?<!\\)\\\[([\s\S]*?)\\\]/g, (_match, inline: string | undefined, block: string | undefined) => inline !== undefined ? `$${inline}$` : `\n$$\n${block}\n$$\n`)
  let offset = 0, result = ''
  for (const [start, end] of protectedRanges) { result += convert(source.slice(offset, start)) + source.slice(start, end); offset = end }
  return result + convert(source.slice(offset))
}
function decodeFilePath(path: string): string { try { return decodeURIComponent(path) } catch { return path } }

type Tree = { type: string; value?: string; url?: string; children?: Tree[] }
function remarkReferences() {
  return (tree: Tree) => {
    const walk = (parent: Tree) => {
      if (!parent.children || ['link', 'image', 'code', 'inlineCode', 'math', 'inlineMath', 'html'].includes(parent.type)) return
      parent.children = parent.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { walk(child); return [child] }
        const parts: Tree[] = []; let offset = 0
        for (const match of child.value.matchAll(/(^|\s)(\/(?:skill:)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}|@[^\s，。；！？]+)(?=\s|$|[.,!?;:])/g)) {
          const start = match.index! + match[1]!.length, token = match[2]!
          parts.push({ type: 'text', value: child.value.slice(offset, start) })
          parts.push({ type: 'link', url: `${token[0] === '/' ? 'pulse-skill' : 'pulse-file'}:${encodeURIComponent(token.slice(1).replace(/^skill:/, ''))}`, children: [{ type: 'text', value: token }] })
          offset = start + token.length
        }
        parts.push({ type: 'text', value: child.value.slice(offset) }); return parts
      })
    }; walk(tree)
  }
}
export function ReferenceChip({ kind, label, path, onClick }: { kind: 'skill' | 'file'; label: string; path: string; onClick?: (() => void) | undefined }) {
  return <span className={`mention-chip ${kind}-chip`} data-kind={kind} title={kind === 'skill' ? `Skill: ${path}` : path} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick} onKeyDown={event => { if (onClick && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onClick() } }}><span className="reference-icon" aria-hidden="true">{kind === 'skill' ? '✦' : path.endsWith('/') ? '▱' : '▤'}</span>{label}</span>
}
function MarkdownImage({ src, alt, imageApi, transport }: { src?: string | undefined; alt?: string | undefined; imageApi?: ((source: string) => string | undefined) | undefined; transport?: PulseWebTransport | undefined }) {
  const [failed, setFailed] = useState(false), [open, setOpen] = useState(false)
  const api = src ? imageApi?.(src) : undefined
  const [localUrl, setLocalUrl] = useState('')
  useEffect(() => {
    if (!api || !transport) return
    let live = true, objectUrl = ''; const controller = new AbortController()
    setLocalUrl(''); setFailed(false)
    void transport.request(api, { signal: controller.signal }).then(async response => {
      const type = response.headers.get('content-type')?.split(';')[0] ?? ''
      if (!response.ok || !type.startsWith('image/') || Number(response.headers.get('content-length') ?? 0) > 32 * 1024 * 1024) throw new Error('IMAGE_UNAVAILABLE')
      const blob = await response.blob(); if (blob.size > 32 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE')
      if (live) { objectUrl = URL.createObjectURL(blob); setLocalUrl(objectUrl) }
    }).catch(() => { if (live) setFailed(true) })
    return () => { live = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [api, transport])
  const imageUrl = api ? localUrl : src
  if (!src || failed) return <span className="markdown-image-fallback" role="img" aria-label={alt || '图片无法加载'}>▧ {alt || '图片无法加载'}</span>
  if (!imageUrl) return <span className="markdown-image-fallback" role="status">正在加载图片…</span>
  return <><img className="markdown-image" src={imageUrl} alt={alt ?? ''} loading="lazy" onError={() => setFailed(true)} onClick={() => setOpen(true)} role="button" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') setOpen(true) }}/>{open && <span className="attachment-modal-overlay" role="dialog" aria-label="图片预览" onClick={() => setOpen(false)} onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}><button autoFocus className="image-preview-close" aria-label="关闭图片预览" onClick={() => setOpen(false)}>×</button><img className="attachment-modal-image" src={imageUrl} alt={alt ?? ''}/></span>}</>
}
export function CodeBlock({ source, language = '' }: { source: string; language?: string }) {
  const [copied, setCopied] = useState(false)
  const highlighted = language && hljs.getLanguage(language) ? hljs.highlight(source, { language }).value : undefined
  return <div className="code-block"><div className="code-head"><span>{language || '代码'}</span><PulseButton type="button" aria-label="复制代码" onClick={() => { void copyText(source).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) }).catch(() => undefined) }}>{copied ? '已复制' : '复制'}</PulseButton></div><pre><code className={highlighted ? `hljs language-${language}` : undefined} dangerouslySetInnerHTML={highlighted ? { __html: highlighted } : undefined}>{highlighted ? undefined : source}</code></pre></div>
}
export const Markdown = memo(function Markdown({ text, onFileClick, onDiffClick, imageApi, transport }: { text: string; imageApi?: ((source: string) => string | undefined) | undefined; transport?: PulseWebTransport | undefined; onFileClick?: ((path: string) => void) | undefined; onDiffClick?: ((path: string) => void) | undefined }) {
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkMath, remarkReferences]} rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false, strict: 'ignore' }]]} urlTransform={url => /^(pulse-skill|pulse-file):/.test(url) ? url : defaultUrlTransform(url)} components={{
    a: ({ href = '', children }) => {
      if (href.startsWith('pulse-skill:')) { const name = decodeURIComponent(href.slice(12)); return <ReferenceChip kind="skill" label={`/${name}`} path={name}/> }
      const path = href.startsWith('pulse-file:') ? decodeURIComponent(href.slice(11)) : decodeFilePath(href)
      if (path && !/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(path) && onFileClick) return <span className="markdown-file-actions"><button className="markdown-file-link" onClick={() => onFileClick(path)}>{href.startsWith('pulse-file:') ? <ReferenceChip kind="file" label={`@${path}`} path={path}/> : children}</button>{onDiffClick && <PulseButton className="markdown-diff-link" aria-label={`查看 ${path} 的差异`} onClick={() => onDiffClick(path)}>查看差异</PulseButton>}</span>
      if (href.startsWith('pulse-file:')) return <ReferenceChip kind="file" label={`@${path}`} path={path}/>
      return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>
    },
    img: ({ src, alt }) => <MarkdownImage key={src} src={src} alt={alt} imageApi={imageApi} transport={transport}/>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
    pre: ({ children }) => {
      const child = Children.toArray(children).find(isValidElement) as ReactElement<{ className?: string; children?: ReactNode }> | undefined
      if (!child) return <pre>{children}</pre>
      return <CodeBlock language={child.props.className?.replace(/^language-/, '') ?? ''} source={String(child.props.children ?? '').replace(/\n$/, '')}/>
    },
  }}>{normalizeMathDelimiters(text)}</ReactMarkdown></div>
})
