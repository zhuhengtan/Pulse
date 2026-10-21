import { PulseButton } from './PulseControls.js'
import { memo, type ReactNode } from 'react'
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

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.origin)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch { return undefined }
}

function inline(source: string, onFileClick?: (path: string) => void): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\)|(?:^|\s)\/(?:skill:)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=\s|$|[.,!?;:])|(?:^|\s)@([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)(?=\s|$|[.,!?;:]))/g
  const result: ReactNode[] = []
  let offset = 0
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > offset) result.push(source.slice(offset, index))
    const token = match[0]
    if (token.startsWith('`')) {
      result.push(<code key={index}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      result.push(<strong key={index}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*')) {
      result.push(<em key={index}>{token.slice(1, -1)}</em>)
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      const href = link?.[2] ? safeHref(link[2].trim()) : undefined
      result.push(href && link ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a> : token)
    } else {
      const leadingSpace = token.match(/^\s+/)?.[0] ?? ''
      const rest = token.slice(leadingSpace.length)
      if (leadingSpace) result.push(leadingSpace)
      if (rest.startsWith('/')) {
        const skillName = rest.slice(1).replace(/^skill:/, '')
        result.push(
          <span key={index} className="mention-chip skill-chip" title={`Skill: ${skillName}`}>
            /{skillName}
          </span>
        )
      } else if (rest.startsWith('@')) {
        const filePath = rest.slice(1)
        result.push(
          <span
            key={index}
            className="mention-chip file-chip"
            title={`文件: ${filePath}`}
            onClick={onFileClick ? () => onFileClick(filePath) : undefined}
          >
            @{filePath}
          </span>
        )
      } else {
        result.push(token)
      }
    }
    offset = index + token.length
  }
  if (offset < source.length) result.push(source.slice(offset))
  return result
}

function tableCells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

function isTableSeparator(row: string): boolean {
  const cells = tableCells(row)
  return row.includes('|') && cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

export const Markdown = memo(function Markdown({ text, onFileClick }: { text: string; onFileClick?: ((path: string) => void) | undefined }) {
  const rows = text.split('\n')
  const blocks: ReactNode[] = []
  for (let index = 0; index < rows.length;) {
    const row = rows[index] ?? ''
    if (row.startsWith('```')) {
      const language = row.slice(3).trim().split(/[\s,]+/)[0]?.toLowerCase() ?? ''
      const code: string[] = []
      index++
      while (index < rows.length && !rows[index]?.startsWith('```')) code.push(rows[index++] ?? '')
      if (index < rows.length) index++
      const source = code.join('\n')
      const highlighted = language && hljs.getLanguage(language) ? hljs.highlight(source, { language }).value : undefined
      blocks.push(<div className="code-block" key={`code-${index}`}><div className="code-head"><span>{language || '代码'}</span><PulseButton type="button" aria-label="复制代码" onClick={event => { const button = event.currentTarget; void copyText(source).then(() => { button.textContent = '已复制'; window.setTimeout(() => { button.textContent = '复制' }, 1200) }).catch(() => undefined) }}>复制</PulseButton></div><pre><code className={highlighted ? `hljs language-${language}` : undefined} dangerouslySetInnerHTML={highlighted ? { __html: highlighted } : undefined}>{highlighted ? undefined : source}</code></pre></div>)
    } else if (!row.trim()) index++
    else if (/^#{1,4}\s/.test(row)) {
      const depth = (row.match(/^#+/)?.[0].length ?? 1) as 1 | 2 | 3 | 4
      const content = inline(row.replace(/^#{1,4}\s+/, ''), onFileClick)
      blocks.push(depth === 1 ? <h1 key={index}>{content}</h1> : depth === 2 ? <h2 key={index}>{content}</h2> : depth === 3 ? <h3 key={index}>{content}</h3> : <h4 key={index}>{content}</h4>)
      index++
    } else if (/^\s*[-*]\s+/.test(row)) {
      const items: ReactNode[] = []
      while (index < rows.length && /^\s*[-*]\s+/.test(rows[index] ?? '')) items.push(<li key={index}>{inline((rows[index++] ?? '').replace(/^\s*[-*]\s+/, ''), onFileClick)}</li>)
      blocks.push(<ul key={`ul-${index}`}>{items}</ul>)
    } else if (/^\s*\d+[.)]\s+/.test(row)) {
      const items: ReactNode[] = []
      while (index < rows.length && /^\s*\d+[.)]\s+/.test(rows[index] ?? '')) items.push(<li key={index}>{inline((rows[index++] ?? '').replace(/^\s*\d+[.)]\s+/, ''), onFileClick)}</li>)
      blocks.push(<ol key={`ol-${index}`}>{items}</ol>)
    } else if (index + 1 < rows.length && isTableSeparator(rows[index + 1] ?? '')) {
      const headings = tableCells(row)
      index += 2
      const body: string[][] = []
      while (index < rows.length && (rows[index] ?? '').includes('|')) body.push(tableCells(rows[index++] ?? ''))
      blocks.push(<div className="table-scroll" key={`table-${index}`}><table><thead><tr>{headings.map((cell, column) => <th key={column}>{inline(cell, onFileClick)}</th>)}</tr></thead><tbody>{body.map((cells, rowIndex) => <tr key={rowIndex}>{headings.map((_, column) => <td key={column}>{inline(cells[column] ?? '', onFileClick)}</td>)}</tr>)}</tbody></table></div>)
    } else if (row.startsWith('> ')) {
      blocks.push(<blockquote key={index}>{inline(row.slice(2), onFileClick)}</blockquote>); index++
    } else {
      const paragraph = [row]
      index++
      while (index < rows.length && rows[index]?.trim() && !/^```|^#{1,4}\s|^\s*[-*]\s+|^\s*\d+[.)]\s+|^> /.test(rows[index] ?? '')) paragraph.push(rows[index++] ?? '')
      blocks.push(<p key={index}>{paragraph.map((line, part) => <span key={part}>{part > 0 && <br />}{inline(line, onFileClick)}</span>)}</p>)
    }
  }
  return <div className="markdown">{blocks}</div>
})
