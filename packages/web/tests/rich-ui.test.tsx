import { useState } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { RichComposer, emptyComposerDraft, type ComposerPayload } from '../src/RichComposer.js'
import { RichMessage } from '../src/RichMessage.js'
import { Markdown, normalizeMathDelimiters } from '../src/Markdown.js'
import { clampHistoryWidth, useResizableHistory } from '../src/useResizableHistory.js'
import { parseRichContent } from '@hunterzhu/pulse-server/rich-content'
beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); localStorage.clear() })
const transport = { request: async () => Response.json({ skills: [], paths: [] }), subscribe: () => () => {} }
function Composer({ send = async () => false }: { send?: (payload: ComposerPayload) => Promise<boolean> }) {
  const [draft, setDraft] = useState(emptyComposerDraft)
  return <RichComposer draft={draft} onChange={setDraft} transport={transport} surfaceMode="work" onSend={send}/>
}
const editorOf = (view: ReturnType<typeof render>) => (view.container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
it('clears marks and heading on an explicit newline, continues lists and exits an empty list item', () => {
  const view = render(<Composer/>), editor = editorOf(view), element = view.container.querySelector('.tiptap')!
  act(() => { editor.commands.setContent({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '标题', marks: [{ type: 'bold' }] }] }] }) })
  act(() => editor.commands.focus('end'))
  fireEvent.keyDown(element, { key: 'Enter', shiftKey: true })
  act(() => editor.commands.insertContent('正文'))
  expect(editor.getJSON().content?.[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: '正文' }] })
  act(() => { editor.commands.setContent('- 第一项'); editor.commands.focus('end') })
  fireEvent.keyDown(element, { key: 'Enter', shiftKey: true })
  expect(editor.getJSON().content?.[0]?.content).toHaveLength(2)
  fireEvent.keyDown(element, { key: 'Enter', shiftKey: true })
  expect(editor.getJSON().content?.at(-1)?.type).toBe('paragraph')
})
it('keeps the previous quoted line when the next line returns to body text', () => {
  const view = render(<Composer/>), editor = editorOf(view)
  act(() => { editor.commands.setContent('> quote'); editor.commands.focus('end') })
  fireEvent.keyDown(view.container.querySelector('.tiptap')!, { key: 'Enter', shiftKey: true })
  act(() => editor.commands.insertContent('body'))
  expect(editor.getJSON().content?.[0]?.type).toBe('blockquote')
  expect(editor.getJSON().content?.[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'body' }] })
})
it('pasted URL has a bounded mark and immediately following text is not linked', () => {
  const view = render(<Composer/>), editor = editorOf(view)
  fireEvent.paste(view.container.querySelector('.tiptap')!, { clipboardData: { files: [], getData: (type: string) => type === 'text/plain' ? 'https://example.com/a' : '' } })
  act(() => editor.commands.insertContent('后续word。'))
  const nodes = editor.getJSON().content?.[0]?.content
  expect(nodes?.[0]?.marks?.[0]).toMatchObject({ type: 'link', attrs: { href: 'https://example.com/a' } })
  expect(nodes?.[1]).toEqual({ type: 'text', text: '后续word。' })
})
it('keeps multiline code and does not send Enter within it', () => {
  const send = vi.fn(async () => false), view = render(<Composer send={send}/>), editor = editorOf(view)
  act(() => { editor.commands.setContent('```js\nlet x = 1\n```'); editor.commands.focus('end') })
  fireEvent.keyDown(view.container.querySelector('.tiptap')!, { key: 'Enter' })
  expect(send).not.toHaveBeenCalled()
  expect(editor.getText()).toContain('let x = 1\n')
})
it('serializes and statically renders reference chips, empty lines and marks without an editor', async () => {
  const send = vi.fn(async () => false), view = render(<Composer send={send}/>), editor = editorOf(view)
  const document = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '说明', marks: [{ type: 'bold' }] }, { type: 'fileChip', attrs: { id: '中文目录/设计 文档.md', label: '设计 文档.md' } }, { type: 'skillChip', attrs: { id: 'review', label: 'review' } }] }, { type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: '最后' }] }] }
  act(() => editor.commands.setContent(document))
  fireEvent.click(view.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  const payload = send.mock.calls[0]![0] as ComposerPayload
  expect(payload.mentionedFiles).toEqual(['中文目录/设计 文档.md'])
  expect(payload.richContent?.version).toBe(1)
  const sent = render(<RichMessage content={payload.richContent} fallback={payload.text}/>)
  expect(sent.container.querySelector('.tiptap')).toBeNull()
  expect(sent.container.querySelectorAll('p')).toHaveLength(3)
  expect(sent.container.querySelector('strong')?.textContent).toBe('说明')
  expect(sent.container.querySelector('.file-chip')?.getAttribute('title')).toBe('中文目录/设计 文档.md')
})
it('does not parse inline Markdown across explicit lines', async () => {
  const view = render(<Composer/>), editor = editorOf(view)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  act(() => editor.commands.setContent('**第一行\n第二行**'))
  expect(editor.getHTML()).not.toContain('<strong>')
  expect(editor.getText()).toContain('**')
})
it('supports editor shortcuts including link dialog, bold and list formatting', () => {
  const view = render(<Composer/>), editor = editorOf(view), element = view.container.querySelector('.tiptap')!
  act(() => { editor.commands.setContent('hello'); editor.commands.setTextSelection({ from: 1, to: 6 }) })
  fireEvent.keyDown(element, { key: 'b', ctrlKey: true })
  expect(editor.getHTML()).toContain('<strong>hello</strong>')
  fireEvent.keyDown(element, { key: 'k', ctrlKey: true })
  expect(view.getByRole('dialog', { name: '编辑链接' })).toBeTruthy()
  fireEvent.change(view.getByLabelText('链接地址'), { target: { value: 'https://example.com' } })
  fireEvent.click(view.getByText('保存'))
  expect(editor.getHTML()).toContain('href="https://example.com"')
})
it('renders GFM, images, math and code while preserving file actions and rejecting HTML', () => {
  const open = vi.fn(), view = render(<Markdown onFileClick={open} onDiffClick={vi.fn()} text={'# Test\n\n- [x] done\n  - nested\n\n~~old~~\n\n| A | B |\n|---|---|\n|1|2|\n\nText ![image](https://example.com/a.png) after $\\frac{1}{2}$\n\n\\[\\sum_{i=0}^n i\\]\n\n[文档](中文/设计%20文档.md)\n\n```js\nconst x = "\\(not math\\)"\n```\n\n<script>bad()</script>\n[bad](javascript:alert(1))'}/>)
  expect(view.container.querySelector('table')).toBeTruthy()
  expect(view.container.querySelectorAll('.katex')).toHaveLength(2)
  expect(view.container.querySelector('img')?.alt).toBe('image')
  expect(view.container.querySelector('script')).toBeNull()
  expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull()
  fireEvent.click(view.getByText('文档')); expect(open).toHaveBeenCalledWith('中文/设计 文档.md')
  expect(view.getByRole('button', { name: '复制代码' })).toBeTruthy()
})
it('preserves math-looking content inside both fence styles and inline code', () => {
  const code = '~~~\n\\(x\\)\n~~~\n`\\(y\\)`'
  expect(normalizeMathDelimiters(code)).toBe(code)
  for (const sample of ['    \\(indented\\)', '> ~~~\n> \\(quoted\\)\n> ~~~']) expect(normalizeMathDelimiters(sample)).toBe(sample)
  expect(normalizeMathDelimiters('before \\(x\\) after')).toBe('before $x$ after')
})
it('validates known presentation nodes, protocols, size and structure', () => {
  const doc = (node: unknown) => ({ version: 1, document: { type: 'doc', content: [node] } })
  expect(() => parseRichContent(doc({ type: 'script' }))).toThrow('RICH_CONTENT_INVALID')
  expect(() => parseRichContent(doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }))).toThrow()
  expect(() => parseRichContent(doc({ type: 'paragraph', content: [{ type: 'text', text: 'a'.repeat(262145) }] }))).toThrow()
})
it('persists sidebar collapse and width and constrains resizing to the viewport', () => {
  function Sidebar() { const state = useResizableHistory(); return <div style={state.style}><button onClick={state.toggle}>toggle</button><div {...state.separator}/></div> }
  expect(clampHistoryWidth(500, 900)).toBe(360)
  const view = render(<Sidebar/>), handle = view.getByRole('separator')
  expect(handle.getAttribute('aria-valuenow')).toBe('260')
  fireEvent.keyDown(handle, { key: 'ArrowRight' }); expect(handle.getAttribute('aria-valuenow')).toBe('280')
  fireEvent.click(view.getByText('toggle')); expect(handle.getAttribute('aria-valuenow')).toBe('0')
  view.unmount(); const restored = render(<Sidebar/>); expect(restored.getByRole('separator').getAttribute('aria-valuenow')).toBe('0')
  fireEvent.click(restored.getByText('toggle')); expect(restored.getByRole('separator').getAttribute('aria-valuenow')).toBe('280')
})

it('does not overwrite a remembered desktop width when mounted on a phone', () => {
  const original = window.innerWidth
  localStorage.setItem('pulse-web-history-layout', JSON.stringify({ width: 360, collapsed: false }))
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  function Sidebar() { useResizableHistory(); return null }
  try { render(<Sidebar/>); expect(JSON.parse(localStorage.getItem('pulse-web-history-layout')!).width).toBe(360) }
  finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: original }) }
})

it('loads workspace images through the authorized transport and releases blob URLs', async () => {
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL
  URL.createObjectURL = vi.fn(() => 'blob:rich-image-test'); URL.revokeObjectURL = vi.fn()
  const request = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }))
  try {
    const view = render(<Markdown text="前文 ![项目图片](assets/test.png) 后文" imageApi={path => `/api/projects/project/file-raw?path=${path}`} transport={{ request, subscribe: () => () => {} }}/>)
    await waitFor(() => expect(view.container.querySelector('.markdown-image')?.getAttribute('src')).toBe('blob:rich-image-test'))
    expect(request).toHaveBeenCalledWith('/api/projects/project/file-raw?path=assets/test.png', expect.objectContaining({ signal: expect.anything() }))
    view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:rich-image-test')
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke }
})
it('keeps partial streamed syntax and malformed formulas readable without executing unsafe content', () => {
  const view = render(<Markdown text={'正在生成 **尚未闭合\n\n$\\unknowncommand{x}$\n\n![图片](javascript:alert(1))\n\n```ts\nconst unfinished = '}/>)
  expect(view.container.textContent).toContain('尚未闭合')
  expect(view.container.querySelector('.katex')).toBeTruthy()
  expect(view.container.textContent).toContain('unknowncommand')
  expect(view.container.querySelector('.markdown-image-fallback')).toBeTruthy()
  expect(view.container.querySelector('pre')?.textContent).toContain('const unfinished')
})
