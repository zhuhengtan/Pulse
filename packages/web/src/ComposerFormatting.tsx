import { useCallback, useEffect, useState } from 'react'
import { Extension, type Editor } from '@tiptap/core'
import Link from '@tiptap/extension-link'
import { BubbleMenu } from '@tiptap/react/menus'
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { safeRichLink } from '@hunterzhu/pulse-server/rich-content'

export const ComposerLink = Link.extend({ inclusive: false }).configure({
  openOnClick: false, autolink: false, linkOnPaste: true, markdownLinks: true,
  isAllowedUri: href => safeRichLink(href),
})

export function composerNewline(editor: Editor): boolean {
  if (editor.isActive('codeBlock')) return editor.commands.newlineInCode()
  const chain = editor.chain()
  if (editor.isActive('listItem')) {
    return chain.command(({ commands }) => commands.splitListItem('listItem') || commands.liftListItem('listItem')).unsetAllMarks().run()
  }
  chain.splitBlock({ keepMarks: false })
  if (editor.isActive('blockquote')) chain.lift('blockquote')
  return chain.command(({ tr }) => {
    tr.setBlockType(tr.selection.from, tr.selection.to, editor.schema.nodes.paragraph!)
    tr.setStoredMarks([])
    return true
  }).run()
}

export const ComposerRules = Extension.create({
  name: 'composerRules', priority: 1100,
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => { this.editor.view.dom.dispatchEvent(new CustomEvent('pulse-edit-link', { bubbles: true })); return true },
      Tab: () => this.editor.isActive('listItem') ? this.editor.commands.sinkListItem('listItem') : false,
      'Shift-Tab': () => this.editor.isActive('listItem') ? this.editor.commands.liftListItem('listItem') : false,
    }
  },
  onCreate() {
    // Parse inline Markdown separately on each explicit line, preserving block/list parsing.
    const storage = this.editor.storage as unknown as { markdown: { parser: { md: any } } }
    const md = storage.markdown.parser.md
    md.core.ruler.after('inline', 'pulse-single-line-marks', (state: any) => {
      for (const token of state.tokens) if (token.type === 'inline' && token.content.includes('\n')) {
        token.children = token.content.split('\n').flatMap((line: string, index: number) => {
          const children: any[] = []; md.inline.parse(line, md, state.env, children)
          return index ? [new state.Token('hardbreak', 'br', 0), ...children] : children
        })
      }
    })
  },
  addProseMirrorPlugins() {
    const schema = this.editor.schema
    const normalize = (fragment: Fragment): Fragment => {
      const result: PMNode[] = []
      fragment.forEach(node => {
        if (node.type.name === 'codeBlock' || node.isLeaf) { result.push(node); return }
        if (node.isTextblock) {
          const lines: PMNode[][] = [[]]
          node.content.forEach(child => {
            if (child.type.name === 'hardBreak') lines.push([])
            else lines[lines.length - 1]!.push(child)
          })
          lines.forEach((line, index) => result.push(index ? schema.nodes.paragraph!.create(null, line) : node.copy(Fragment.from(line))))
        } else result.push(node.copy(normalize(node.content)))
      })
      return Fragment.from(result)
    }
    return [new Plugin({ props: { transformPasted: slice => {
      const content = normalize(slice.content)
      return new Slice(content, Math.min(slice.openStart, Slice.maxOpen(content).openStart), Math.min(slice.openEnd, Slice.maxOpen(content).openEnd))
    } } })]
  },
})

const bubbleOptions = { placement: 'top' as const, offset: 10, flip: true, shift: { padding: 12 } }
export function ComposerBubbleMenu({ editor }: { editor: Editor }) {
  const [, refresh] = useState(0), [linkOpen, setLinkOpen] = useState(false), [url, setUrl] = useState(''), [error, setError] = useState('')
  const [savedRange, setSavedRange] = useState<{ from: number; to: number }>()
  const openLink = () => { setSavedRange({ from: editor.state.selection.from, to: editor.state.selection.to }); setUrl(String(editor.getAttributes('link').href ?? '')); setError(''); setLinkOpen(true) }
  useEffect(() => {
    const update = ({ transaction }: { transaction: Transaction }) => { if (transaction.docChanged || transaction.selectionSet || transaction.storedMarksSet) refresh(value => value + 1) }
    editor.on('transaction', update)
    editor.view.dom.addEventListener('pulse-edit-link', openLink)
    return () => { editor.off('transaction', update); editor.view.dom.removeEventListener('pulse-edit-link', openLink) }
  }, [editor])
  const shouldShow = useCallback(({ state }: { state: EditorState }) => editor.isEditable && !state.selection.empty && state.selection.$from.parent.type.name !== 'codeBlock' && !linkOpen, [editor, linkOpen])
  const format = (kind: string) => {
    const chain = editor.chain().focus()
    if (kind === 'paragraph') chain.setParagraph().unsetBlockquote()
    else if (/^h[123]$/.test(kind)) chain.toggleHeading({ level: Number(kind[1]) as 1 | 2 | 3 })
    else if (kind === 'bulletList') chain.toggleBulletList()
    else if (kind === 'orderedList') chain.toggleOrderedList()
    else if (kind === 'blockquote') chain.toggleBlockquote()
    else if (kind === 'strike') chain.toggleStrike()
    else if (kind === 'code') chain.toggleCode()
    else if (kind === 'codeBlock') chain.toggleCodeBlock()
    else if (kind === 'clear') chain.clearNodes().unsetAllMarks()
    chain.run()
  }
  const active = editor.isActive('orderedList') ? 'orderedList' : editor.isActive('bulletList') ? 'bulletList' : editor.isActive('heading') ? `h${editor.getAttributes('heading').level}` : editor.isActive('blockquote') ? 'blockquote' : editor.isActive('codeBlock') ? 'codeBlock' : 'paragraph'
  return <>
    <BubbleMenu editor={editor} options={bubbleOptions} shouldShow={shouldShow}>
      <div className="composer-bubble" role="toolbar" aria-label="文本格式" onMouseDown={event => { if ((event.target as HTMLElement).tagName !== 'SELECT') event.preventDefault() }}>
        <button type="button" title="链接 · Cmd/Ctrl+K" aria-label="添加或编辑链接" aria-pressed={editor.isActive('link')} onClick={openLink}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2"/></svg></button>
        <button type="button" title="粗体 · Cmd/Ctrl+B" aria-label="粗体" aria-pressed={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
        <button type="button" title="斜体 · Cmd/Ctrl+I" aria-label="斜体" aria-pressed={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
        <select aria-label="段落与列表格式" value={active} onChange={event => format(event.target.value)}>
          <option value="paragraph">正文</option><option value="h1">标题 1</option><option value="h2">标题 2</option><option value="h3">标题 3</option><option value="orderedList">编号列表</option><option value="bulletList">项目符号</option><option value="blockquote">引用</option><option value="strike">删除线</option><option value="code">行内代码</option><option value="codeBlock">代码块</option><option value="clear">清除格式</option>
        </select>
      </div>
    </BubbleMenu>
    {linkOpen && <div className="composer-link-dialog" role="dialog" aria-label="编辑链接" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { setLinkOpen(false); editor.commands.focus() } }}>
      <form onSubmit={event => {
        event.preventDefault(); const href = url.trim()
        if (href && !safeRichLink(href)) { setError('请输入 http、https 或 mailto 链接'); return }
        const chain = editor.chain().focus(); if (savedRange) chain.setTextSelection(savedRange)
        if (href) { if (savedRange?.from === savedRange?.to && !editor.isActive('link')) chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).unsetMark('link'); else chain.extendMarkRange('link').setLink({ href }) }
        else chain.extendMarkRange('link').unsetLink()
        chain.run(); setLinkOpen(false)
      }}>
        <input autoFocus aria-label="链接地址" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…"/>
        <button type="submit">{url ? '保存' : '移除链接'}</button><button type="button" onClick={() => { setLinkOpen(false); editor.commands.focus() }}>取消</button>
      </form>{error && <span role="alert">{error}</span>}
    </div>}
  </>
}
