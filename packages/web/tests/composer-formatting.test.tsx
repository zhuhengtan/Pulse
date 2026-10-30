import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { ComposerBubbleMenu, ComposerLink, ComposerRules } from '../src/ComposerFormatting.js'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  window.scrollBy = () => {}
  const rect = () => ({ x: 0, y: 0, top: 8, bottom: 24, left: 8, right: 80, width: 72, height: 16, toJSON() { return {} } })
  Range.prototype.getClientRects = () => [rect()] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = rect
})

const editors: Editor[] = []
const hosts: HTMLElement[] = []
afterEach(() => {
  cleanup()
  for (const editor of editors.splice(0)) if (!editor.isDestroyed) editor.destroy()
  for (const host of hosts.splice(0)) host.remove()
  vi.restoreAllMocks()
})

function host() {
  const element = document.createElement('div')
  document.body.append(element)
  hosts.push(element)
  return element
}

function createEditor(element: HTMLElement | null) {
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false, trailingNode: false }),
      Markdown.configure({ html: false, breaks: true, transformPastedText: true, transformCopiedText: true }),
      ComposerLink,
      ComposerRules,
    ],
    content: '保留草稿',
  })
  editors.push(editor)
  return editor
}

function spyLinkListeners() {
  const added: Array<{ node: HTMLElement; listener: EventListener }> = []
  const removed: Array<{ node: HTMLElement; listener: EventListener }> = []
  const originalAdd = HTMLElement.prototype.addEventListener
  const originalRemove = HTMLElement.prototype.removeEventListener
  vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
    if (type === 'pulse-edit-link') added.push({ node: this, listener: listener as EventListener })
    return originalAdd.call(this, type, listener, options)
  })
  vi.spyOn(HTMLElement.prototype, 'removeEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
    if (type === 'pulse-edit-link') removed.push({ node: this, listener: listener as EventListener })
    return originalRemove.call(this, type, listener, options)
  })
  return { added, removed }
}

it('binds the link listener only after the editor view exists', () => {
  const editor = createEditor(null)
  expect(editor.isDestroyed).toBe(true)
  const { added } = spyLinkListeners()
  render(<ComposerBubbleMenu editor={editor} />)
  expect(added).toHaveLength(0)
  editor.mount(host())
  expect(added).toEqual([{ node: editor.view.dom, listener: added[0]!.listener }])
})

it('keeps formatting, Mod-K, links, and the draft after the view is destroyed before cleanup', async () => {
  const editor = createEditor(host())
  const { added, removed } = spyLinkListeners()
  const view = render(<ComposerBubbleMenu editor={editor} />)
  expect(added).toHaveLength(1)
  const captured = added[0]!
  expect(captured.node).toBe(editor.view.dom)
  act(() => { editor.commands.keyboardShortcut('Mod-k') })
  expect(view.getByRole('dialog', { name: '编辑链接' })).toBeTruthy()
  fireEvent.change(view.getByRole('textbox', { name: '链接地址' }), { target: { value: 'https://example.com/draft' } })
  fireEvent.click(view.getByRole('button', { name: '保存' }))
  expect(editor.getHTML()).toContain('href="https://example.com/draft"')
  expect(editor.getText()).toContain('保留草稿')
  editor.commands.setTextSelection({ from: 1, to: 3 })
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: '粗体' })))
  fireEvent.change(screen.getByRole('combobox', { name: '段落与列表格式' }), { target: { value: 'h1' } })
  expect(editor.getHTML()).toContain('<strong>')
  expect(editor.getHTML()).toContain('<h1>')
  expect(editor.getText()).toContain('保留草稿')
  editor.destroy()
  expect(() => editor.view.dom).toThrow(/view is not available/)
  expect(removed.some(item => item.listener === captured.listener)).toBe(false)
  expect(() => view.unmount()).not.toThrow()
  expect(removed).toContainEqual({ node: captured.node, listener: captured.listener })
  captured.node.dispatchEvent(new CustomEvent('pulse-edit-link'))
  expect(document.querySelector('[aria-label="编辑链接"]')).toBeNull()
})
