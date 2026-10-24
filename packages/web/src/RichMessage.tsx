import { createElement, Fragment, type ReactNode } from 'react'
import { parseRichContent, type RichContent, type RichNode } from '@hunterzhu/pulse-server/rich-content'
import { Markdown, ReferenceChip } from './Markdown.js'

export function RichMessage({ content, fallback, onFileClick, onDiffClick }: { content?: RichContent | undefined; fallback: string; onFileClick?: ((path: string) => void) | undefined; onDiffClick?: ((path: string) => void) | undefined }) {
  let document: RichNode | undefined
  try { document = parseRichContent(content)?.document } catch { /* Unknown versions and corrupt legacy data use readable Markdown. */ }
  if (!document) return <Markdown text={fallback} onFileClick={onFileClick} onDiffClick={onDiffClick}/>
  const render = (node: RichNode, key: number): ReactNode => {
    const children = node.content?.map(render)
    let value: ReactNode
    if (node.type === 'text') value = node.text
    else if (node.type === 'skillChip' || node.type === 'fileChip') {
      const path = String(node.attrs?.id ?? ''), label = String(node.attrs?.label ?? path), skill = node.type === 'skillChip'
      value = <ReferenceChip kind={skill ? 'skill' : 'file'} label={`${skill ? '/' : '@'}${label}`} path={path} onClick={!skill && onFileClick ? () => onFileClick(path) : undefined}/>
    } else if (node.type === 'doc') value = <Fragment>{children}</Fragment>
    else if (node.type === 'codeBlock') value = <pre><code>{children}</code></pre>
    else {
      const tag = ({ paragraph: 'p', blockquote: 'blockquote', bulletList: 'ul', orderedList: 'ol', listItem: 'li', hardBreak: 'br', horizontalRule: 'hr', heading: `h${node.attrs?.level ?? 1}` } as Record<string, string>)[node.type] ?? 'span'
      value = createElement(tag, node.type === 'orderedList' ? { start: node.attrs?.start ?? 1 } : {}, children)
    }
    for (const mark of node.marks ?? []) value = mark.type === 'link' ? <a href={String(mark.attrs?.href)} target="_blank" rel="noopener noreferrer">{value}</a> : createElement(({ bold: 'strong', italic: 'em', strike: 's', code: 'code', underline: 'u' } as Record<string, string>)[mark.type] ?? 'span', {}, value)
    return <Fragment key={key}>{value}</Fragment>
  }
  return <div className="rich-document">{render(document, 0)}</div>
}
