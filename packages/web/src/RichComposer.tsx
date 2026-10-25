import { mentionLocation, parentMentionDirectory } from './fileMentions.js'
import { AttachmentCards } from './AttachmentCards.js'
import { parseRichContent, type RichContent } from '@hunterzhu/pulse-server/rich-content'
import { ComposerBubbleMenu, ComposerLink, ComposerRules, composerNewline } from './ComposerFormatting.js'
import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { Node, Extension, mergeAttributes, type JSONContent, type Editor } from '@tiptap/core'
import { Suggestion, exitSuggestion, type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { Dropdown } from 'antd'
import type { FollowupBehavior } from './MessageQueue.js'
import { Icon } from './Icon.js'
import { PulseButton } from './PulseControls.js'
import { apiJson, type PulseWebTransport, type WebAttachment } from './transport.js'

export interface AttachmentDraft {
  id: string
  name: string
  type: 'image' | 'file'
  size: number
  mediaType: string
  previewUrl?: string | undefined
  data: string
}

export interface ComposerDraft {
  markdown: string
  document?: JSONContent | undefined
  attachments: AttachmentDraft[]
  processing: number
  revision: number
}
export const emptyComposerDraft = (): ComposerDraft => ({ markdown: '', attachments: [], processing: 0, revision: 0 })
export type ComposerPayload = { text: string; richContent?: RichContent | undefined; attachments?: WebAttachment[] | undefined; skills?: string[] | undefined; mentionedFiles?: string[] | undefined }

const fileSuggestionKey = new PluginKey('fileSuggestion')

export interface SuggestionItem {
  id: string
  name: string
  description?: string
  directory?: boolean
}

export interface RichComposerProps {
  submitLabel?: string | undefined
  id?: string | undefined
  draft: ComposerDraft
  placeholder?: string | undefined
  disabled?: boolean | undefined
  submitting?: boolean | undefined
  running?: boolean | undefined
  stopping?: boolean | undefined
  surfaceMode: 'chat' | 'work'
  projectId?: string | undefined
  transport: PulseWebTransport
  followupBehavior?: FollowupBehavior | undefined
  onSend: (payload: ComposerPayload, behavior?: FollowupBehavior) => Promise<boolean>
  onStop?: (() => void) | undefined
  toolbarExtra?: React.ReactNode
  onChange: (update: (current: ComposerDraft) => ComposerDraft) => void
}

const SkillChip = Node.create({
  name: 'skillChip',
  group: 'inline',
  inline: true,
  selectable: true,
  atom: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: element => element.getAttribute('data-id'),
        renderHTML: attributes => ({ 'data-id': attributes.id }),
      },
      label: {
        default: null,
        parseHTML: element => element.getAttribute('data-label'),
        renderHTML: attributes => ({ 'data-label': attributes.label }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="skill-chip"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = node.attrs.label || node.attrs.id || ''
    return [
      'span',
      mergeAttributes({ 'data-type': 'skill-chip', class: 'mention-chip skill-chip', title: node.attrs.id }, HTMLAttributes),
      ['span', { class: 'reference-icon', 'aria-hidden': 'true' }, '✦'], `/${label}`,
    ]
  },

  renderText({ node }) {
    return `/${node.attrs.id || node.attrs.label}`
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`/${node.attrs.id || node.attrs.label}`)
        },
      },
    }
  },
})

const FileChip = Node.create({
  name: 'fileChip',
  group: 'inline',
  inline: true,
  selectable: true,
  atom: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: element => element.getAttribute('data-id'),
        renderHTML: attributes => ({ 'data-id': attributes.id }),
      },
      label: {
        default: null,
        parseHTML: element => element.getAttribute('data-label'),
        renderHTML: attributes => ({ 'data-label': attributes.label }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="file-chip"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = node.attrs.label || node.attrs.id || ''
    return [
      'span',
      mergeAttributes({ 'data-type': 'file-chip', class: 'mention-chip file-chip', title: node.attrs.id }, HTMLAttributes),
      ['span', { class: 'reference-icon', 'aria-hidden': 'true' }, String(node.attrs.id ?? '').endsWith('/') ? '▱' : '▤'], `@${label}`,
    ]
  },

  renderText({ node }) {
    return `@${node.attrs.id || node.attrs.label}`
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`@${node.attrs.id || node.attrs.label}`)
        },
      },
    }
  },
})


function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function compressImage(file: File): Promise<AttachmentDraft> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      const maxDim = 2048
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width)
          width = maxDim
        } else {
          width = Math.round((width * maxDim) / height)
          height = maxDim
        }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas context unavailable'))
        return
      }
      ctx.drawImage(img, 0, 0, width, height)
      const mediaType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      let dataUrl = canvas.toDataURL(mediaType, 0.85)
      while (dataUrl.length > 4 * 1024 * 1024 && canvas.width > 128 && canvas.height > 128) {
        width = Math.max(1, Math.floor(canvas.width * 0.8)); height = Math.max(1, Math.floor(canvas.height * 0.8))
        canvas.width = width; canvas.height = height
        ctx.drawImage(img, 0, 0, width, height)
        dataUrl = canvas.toDataURL(mediaType, 0.85)
      }
      if (dataUrl.length > 4 * 1024 * 1024) { reject(new Error('图片压缩后仍超过模型输入上限')); return }
      const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '')
      const size = Math.round((base64Data.length * 3) / 4)
      resolve({
        id: globalThis.crypto?.randomUUID?.() ?? `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name.replace(/\.[^.]+$/, mediaType === 'image/png' ? '.png' : '.jpg'),
        type: 'image',
        size,
        mediaType,
        previewUrl: dataUrl,
        data: dataUrl,
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}

export function RichComposer({
  id: composerId = 'composer',
  submitLabel,
  draft,
  placeholder,
  disabled = false,
  submitting = false,
  running = false,
  stopping = false,
  surfaceMode,
  projectId,
  transport,
  followupBehavior = 'queue',
  onSend,
  onStop,
  toolbarExtra,
  onChange,
}: RichComposerProps) {
  const { markdown: value, attachments } = draft
  const draftRef = useRef(draft)
  draftRef.current = draft
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder
  const [sendError, setSendError] = useState('')
  const sendingRef = useRef(false)
  const setAttachments = (update: (current: AttachmentDraft[]) => AttachmentDraft[]) => onChange(current => ({ ...current, attachments: update(current.attachments), revision: current.revision + 1 }))
  const [isDragOver, setIsDragOver] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [sendMenuOpen, setSendMenuOpen] = useState(false)
  const followupRef = useRef({ running, followupBehavior }); followupRef.current = { running, followupBehavior }
  const fileInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hasContent, setHasContent] = useState(Boolean(value.trim()))

  // Suggestions state
  const [suggestionState, setSuggestionState] = useState<{
    type: 'skill' | 'file'
    items: SuggestionItem[]
    command: (item: SuggestionItem) => void
    selectedIndex: number
    directory?: string
    loading?: boolean
    navigate?: (path: string) => void
  } | null>(null)

  const suggestionRef = useRef(suggestionState)
  suggestionRef.current = suggestionState

  const suggestionMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => { suggestionMenuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [suggestionState?.selectedIndex, suggestionState?.items])

  const currentProjectIdRef = useRef(projectId)
  currentProjectIdRef.current = projectId

  // Fetch skills helper
  const fetchSkills = useCallback(async (): Promise<SuggestionItem[]> => {
    try {
      const res = await apiJson<{ skills: Array<{ id: string; name: string }> }>(transport, '/api/skills')
      return res.skills || []
    } catch {
      return []
    }
  }, [transport])

  // Fetch project files helper
  const fetchProjectFiles = useCallback(async (pId: string, query: string): Promise<SuggestionItem[]> => {
    try {
      const { directory, filter } = mentionLocation(query)
      const res = await apiJson<{ entries: Array<{ name: string; path: string; type: string }> }>(transport, `/api/projects/${encodeURIComponent(pId)}/files?path=${encodeURIComponent(directory || '.')}`)
      return (res.entries || []).filter(entry => ['directory', 'file'].includes(entry.type) && entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
        .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name))
        .map(entry => ({ id: entry.path + (entry.type === 'directory' ? '/' : ''), name: entry.name, directory: entry.type === 'directory' }))
    } catch {
      return []
    }
  }, [transport])

  const handleSend = async (behavior?: FollowupBehavior) => {
    if (disabled || submitting || stopping || sendingRef.current || draft.processing) return
    const currentMarkdown = (editor?.storage as any)?.markdown?.getMarkdown?.() ?? ''
    const trimmed = currentMarkdown.trim()
    if (!trimmed && attachments.length === 0) return

    // Extract skills
    const skillsFound: string[] = []
    if (editor) {
      editor.state.doc.descendants(node => {
        if (node.type.name === 'skillChip' && node.attrs.id) {
          skillsFound.push(node.attrs.id)
        }
      })
    }
    const skillRegex = /(?:^|\s)\/(?:skill:)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=\s|$|[.,!?;:])/g
    let sm: RegExpExecArray | null
    while ((sm = skillRegex.exec(trimmed)) !== null) {
      if (sm[1]) skillsFound.push(sm[1])
    }

    // Extract mentioned files
    const filesFound: string[] = []
    if (editor) {
      editor.state.doc.descendants(node => {
        if (node.type.name === 'fileChip' && node.attrs.id) {
          filesFound.push(node.attrs.id)
        }
      })
    }
    const uniqueSkills = [...new Set(skillsFound)]
    const uniqueFiles = [...new Set(filesFound)]

    const webAttachments: WebAttachment[] = attachments.map(att => ({
      id: att.id,
      name: att.name,
      type: att.type,
      size: att.size,
      mediaType: att.mediaType,
      data: att.data,
    }))

    let richContent: RichContent
    try { richContent = parseRichContent({ version: 1, document: editor!.getJSON() })! }
    catch { setSendError('内容格式或长度不受支持，请调整后重试。草稿已保留。'); return }
    const snapshotRevision = draft.revision
    const payload: ComposerPayload = {
      text: trimmed,
      richContent,
      ...(webAttachments.length ? { attachments: webAttachments } : {}),
      ...(uniqueSkills.length ? { skills: uniqueSkills } : {}),
      ...(uniqueFiles.length ? { mentionedFiles: uniqueFiles } : {}),
    }
    if (new TextEncoder().encode(JSON.stringify({ ...payload, requestId: 'x'.repeat(128) })).length > 35 * 1024 * 1024) {
      setSendError('附件总量超过单次发送上限，请减少附件后重试。'); return
    }
    sendingRef.current = true
    setSendError('')
    try {
      if (await onSend(payload, behavior ?? followupBehavior)) {
        onChange(current => current.revision === snapshotRevision ? { ...emptyComposerDraft(), revision: current.revision + 1 } : current)
        if (draftRef.current.revision === snapshotRevision && !editor?.isDestroyed) {
          editor?.commands.setContent('', { emitUpdate: false })
          setHasContent(false)
        }
      }
    } catch { setSendError('消息发送失败，草稿和附件已保留。') }
    finally { sendingRef.current = false }
  }

  // Handle files added
  const handleFilesAdded = useCallback(async (files: File[]) => {
    if (disabled || submitting) return
    // Reserve slots synchronously so overlapping paste/drop operations cannot exceed ten.
    const remainingSlots = 10 - draftRef.current.attachments.length - draftRef.current.processing
    if (remainingSlots <= 0) { setSendError('单次最多添加 10 个附件'); return }
    if (files.length > remainingSlots) setSendError(`单次最多添加 10 个附件，本次只添加前 ${remainingSlots} 个。`)
    const toProcess = files.slice(0, remainingSlots)
    draftRef.current = { ...draftRef.current, processing: draftRef.current.processing + toProcess.length }
    onChange(current => ({ ...current, processing: current.processing + toProcess.length }))
    const newAttachments: AttachmentDraft[] = []

    for (const file of toProcess) {
      if (file.size > 20 * 1024 * 1024) {
        setSendError(`${file.name} 超过 20MB 上限，已跳过`)
        continue
      }
      try {
        if (['image/png', 'image/jpeg'].includes(file.type)) {
          if (file.size > 1024 * 1024) {
            const compressed = await compressImage(file)
            newAttachments.push(compressed)
          } else {
            const data = await readFileAsBase64(file)
            newAttachments.push({
              id: globalThis.crypto?.randomUUID?.() ?? `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              name: file.name,
              type: 'image',
              size: file.size,
              mediaType: file.type || 'image/png',
              previewUrl: data,
              data,
            })
          }
        } else {
          const data = await readFileAsBase64(file)
          newAttachments.push({
            id: globalThis.crypto?.randomUUID?.() ?? `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: file.name,
            type: 'file',
            size: file.size,
            mediaType: file.type || 'application/octet-stream',
            data,
          })
        }
      } catch (err) {
        setSendError(`无法读取附件 ${file.name}，请重新添加。`)
        console.error('Failed to process file:', err)
      }
    }

    onChange(current => ({ ...current, attachments: [...current.attachments, ...newAttachments], processing: Math.max(0, current.processing - toProcess.length), revision: current.revision + 1 }))
  }, [disabled, submitting, onChange])

  // Configure Tiptap editor
  const editor: Editor | null = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false,
        trailingNode: false,
      }),
      Placeholder.configure({
        showOnlyWhenEditable: false,
        placeholder: () => placeholderRef.current || '给 Pulse 发送消息…',
      }),
      Markdown.configure({ html: false, breaks: true, transformPastedText: true, transformCopiedText: true }),
      ComposerLink,
      ComposerRules,
      SkillChip,
      FileChip,
      Extension.create({
        name: 'skillSuggestion',
        addProseMirrorPlugins() {
          return [
            Suggestion({
              editor: this.editor,
              char: '/',
              pluginKey: new PluginKey('skillSuggestion'),
              allow: ({ state, range }) => {
                const $from = state.doc.resolve(range.from)
                const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\uFFFC')
                return textBefore.length === 0 || /\s$/.test(textBefore)
              },
              items: async ({ query }: { query: string }) => {
                const allSkills = await fetchSkills()
                if (!query) return allSkills.slice(0, 15)
                const q = query.toLowerCase()
                return allSkills.filter(s => s.name.toLowerCase().includes(q)).slice(0, 15)
              },
              command: ({ editor, range, props }) => {
                editor
                  .chain()
                  .focus()
                  .insertContentAt(range, [
                    {
                      type: 'skillChip',
                      attrs: { id: props.id, label: props.name },
                    },
                    {
                      type: 'text',
                      text: ' ',
                    },
                  ])
                  .run()
              },
              render: () => ({
                onStart: (props: SuggestionProps) => {
                  setSuggestionState({
                    type: 'skill',
                    items: props.items,
                    command: props.command,
                    selectedIndex: 0,
                  })
                },
                onUpdate: (props: SuggestionProps) => {
                  setSuggestionState(current => {
                    if (!current) return null
                    return {
                      ...current,
                      items: props.items,
                      command: props.command,
                      selectedIndex: 0,
                    }
                  })
                },
                onKeyDown: (props: SuggestionKeyDownProps) => {
                  if (props.event.key === 'ArrowUp') {
                    setSuggestionState(current => {
                      if (!current || !current.items.length) return current
                      const next = (current.selectedIndex + current.items.length - 1) % current.items.length
                      return { ...current, selectedIndex: next }
                    })
                    return true
                  }
                  if (props.event.key === 'ArrowDown') {
                    setSuggestionState(current => {
                      if (!current || !current.items.length) return current
                      const next = (current.selectedIndex + 1) % current.items.length
                      return { ...current, selectedIndex: next }
                    })
                    return true
                  }
                  if (props.event.key === 'Enter' || props.event.key === 'Tab') {
                    const current = suggestionRef.current
                    const item = current?.items[current.selectedIndex]
                    if (item && current) {
                      current.command(item)
                      return true
                    }
                    return false
                  }
                  if (props.event.key === 'Escape') {
                    setSuggestionState(null)
                    return true
                  }
                  return false
                },
                onExit: () => {
                  setSuggestionState(null)
                },
              }),
            }),
          ]
        },
      }),
      Extension.create({
        name: 'fileSuggestion',
        addProseMirrorPlugins() {
          return [
            Suggestion({
              editor: this.editor,
              char: '@',
              allowSpaces: true,
              pluginKey: fileSuggestionKey,
              allow: ({ state, range }) => {
                const $from = state.doc.resolve(range.from)
                const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\uFFFC')
                return textBefore.length === 0 || /\s$/.test(textBefore)
              },
              items: async ({ query }: { query: string }) => {
                const pId = currentProjectIdRef.current
                if (!pId) return []
                return await fetchProjectFiles(pId, query)
              },
              command: ({ editor, range, props }) => {
                editor
                  .chain()
                  .focus()
                  .insertContentAt(range, [
                    {
                      type: 'fileChip',
                      attrs: { id: props.id, label: props.name + (props.directory ? '/' : '') },
                    },
                    {
                      type: 'text',
                      text: ' ',
                    },
                  ])
                  .run()
              },
              render: () => ({
                onStart: (props: SuggestionProps) => {
                  setSuggestionState({
                    type: 'file',
                    directory: mentionLocation(props.query).directory,
                    navigate: path => { props.editor.chain().focus().insertContentAt(props.range, `@${path}`).run() },
                    items: props.loading ? [] : props.items,
                    loading: props.loading,
                    command: props.command,
                    selectedIndex: 0,
                  })
                },
                onUpdate: (props: SuggestionProps) => {
                  setSuggestionState(current => {
                    if (!current) return null
                    return {
                      ...current,
                      directory: mentionLocation(props.query).directory,
                      navigate: path => { props.editor.chain().focus().insertContentAt(props.range, `@${path}`).run() },
                      items: props.loading ? [] : props.items,
                    loading: props.loading,
                      command: props.command,
                      selectedIndex: 0,
                    }
                  })
                },
                onKeyDown: (props: SuggestionKeyDownProps) => {
                  if (props.event.isComposing) return false
                  const state = suggestionRef.current
                  if (props.event.key === 'ArrowRight' || props.event.key === 'ArrowLeft') {
                    const item = state?.items[state.selectedIndex]
                    if (props.event.key === 'ArrowRight' && item?.directory) state?.navigate?.(item.id)
                    if (props.event.key === 'ArrowLeft' && state?.directory) state.navigate?.(parentMentionDirectory(state.directory))
                    return true
                  }
                  if (props.event.key === 'ArrowUp') {
                    setSuggestionState(current => {
                      if (!current || !current.items.length) return current
                      const next = (current.selectedIndex + current.items.length - 1) % current.items.length
                      return { ...current, selectedIndex: next }
                    })
                    return true
                  }
                  if (props.event.key === 'ArrowDown') {
                    setSuggestionState(current => {
                      if (!current || !current.items.length) return current
                      const next = (current.selectedIndex + 1) % current.items.length
                      return { ...current, selectedIndex: next }
                    })
                    return true
                  }
                  if (props.event.key === 'Enter' || props.event.key === 'Tab') {
                    const current = suggestionRef.current
                    const item = current?.items[current.selectedIndex]
                    if (item && current) {
                      current.command(item)
                      return true
                    }
                    return true
                  }
                  if (props.event.key === 'Escape') {
                    exitSuggestion(props.view, fileSuggestionKey)
                    setSuggestionState(null)
                    return true
                  }
                  return false
                },
                onExit: () => {
                  setSuggestionState(null)
                },
              }),
            }),
          ]
        },
      }),
    ],
    content: draft.document ?? value,
    editable: !disabled,
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (suggestionRef.current || fileSuggestionKey.getState(_view.state)?.active) return false
        if (event.key === 'Enter') {
          const isMobile = window.matchMedia('(max-width: 767px)').matches
          if (event.isComposing) return false
          if ((!isMobile && !event.shiftKey && !editor?.isActive('codeBlock')) || event.metaKey || event.ctrlKey) {
            event.preventDefault()
            const current = followupRef.current
            void sendRef.current(current.running && (event.metaKey || event.ctrlKey) ? current.followupBehavior === 'queue' ? 'immediate' : 'queue' : undefined)
            return true
          }
          if (editor?.isActive('codeBlock') && !event.shiftKey) return false
          event.preventDefault()
          return editor ? composerNewline(editor) : false
        }
        return false
      },
      handlePaste: (_view, event) => {
        if (event.clipboardData?.files?.length) {
          event.preventDefault()
          void handleFilesAdded(Array.from(event.clipboardData.files))
          return true
        }
        const pasted = event.clipboardData?.getData('text/plain')?.trim()
        if (pasted && /^https?:\/\/[^\s]+$/.test(pasted) && editor) {
          event.preventDefault()
          editor.chain().insertContent({ type: 'text', text: pasted, marks: [{ type: 'link', attrs: { href: pasted } }] }).unsetMark('link').run()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      const md = (currentEditor.storage as any)?.markdown?.getMarkdown?.() ?? ''
      setHasContent(Boolean(md.trim()))
      onChange(current => ({ ...current, markdown: md, document: currentEditor.getJSON(), revision: current.revision + 1 }))
    },
  })

  // Synchronize external value updates
  useEffect(() => {
    if (!editor) return
    const currentMarkdown = (editor.storage as any)?.markdown?.getMarkdown?.() ?? ''
    if (value !== currentMarkdown || draft.document && JSON.stringify(draft.document) !== JSON.stringify(editor.getJSON())) {
      editor.commands.setContent(draft.document ?? value, { emitUpdate: false })
      setHasContent(Boolean(value.trim()))
    }
  }, [value, draft.document, editor])

  // Synchronize disabled state
  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled, false)
    }
  }, [disabled, editor, placeholder])

  const sendRef = useRef(handleSend)
  sendRef.current = handleSend
  const canSubmit = (hasContent || attachments.length > 0) && !draft.processing && !submitting && !disabled && !stopping

  return (
    <div
      ref={containerRef}
      className={`rich-composer ${isDragOver ? 'is-dragover' : ''}`}
      onDragOverCapture={e => {
        e.preventDefault()
        if (!disabled) { e.dataTransfer.dropEffect = 'copy'; setIsDragOver(true) }
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDropCapture={e => {
        setIsDragOver(false)
        if (e.dataTransfer.files.length) {
          e.preventDefault()
          e.stopPropagation()
          if (disabled) return
          void handleFilesAdded(Array.from(e.dataTransfer.files))
        }
      }}
    >
      {sendError && <div role="alert">{sendError}</div>}
      {draft.processing > 0 && <div role="status">正在处理附件…</div>}
      {/* Suggestions Menu */}
      {suggestionState && (
        <div className="composer-suggestion-popup" ref={suggestionMenuRef}>
          <div className="suggestion-header">
            {suggestionState.type === 'skill' ? '推荐 Skill' : <>
              <button type="button" onMouseDown={event => { event.preventDefault(); suggestionState.navigate?.('') }}>项目</button>
              {(suggestionState.directory ?? '').split('/').filter(Boolean).map((name, index, parts) => <span key={index}><span aria-hidden="true"> / </span><button type="button" onMouseDown={event => { event.preventDefault(); suggestionState.navigate?.(parts.slice(0, index + 1).join('/') + '/') }}>{name}</button></span>)}
            </>}
          </div>
          <div className="suggestion-options" role="listbox" aria-label={suggestionState.type === 'file' ? '项目文件与文件夹' : 'Skill'}>
          {suggestionState.items.length === 0 ? (
            <div className="suggestion-empty">
              {suggestionState.loading ? '正在读取目录…' : suggestionState.type === 'file' && !projectId
                ? '当前会话未关联项目，无法索引文件'
                : '未找到匹配项'}
            </div>
          ) : (
            suggestionState.items.map((item, index) => (
              <div
                key={item.id}
                role="option"
                aria-selected={index === suggestionState.selectedIndex}
                className={`suggestion-item ${index === suggestionState.selectedIndex ? 'is-selected' : ''}`}
                onMouseDown={e => {
                  e.preventDefault()
                  suggestionState.command(item)
                }}
              >
                <span className="suggestion-item-icon">
                  <Icon name={suggestionState.type === 'skill' ? 'tool' : item.directory ? 'folder' : 'file'}/>
                </span>
                <span className="suggestion-item-name" title={item.id}>{item.name}</span>
                {item.directory && <button type="button" className="suggestion-enter" aria-label={`进入 ${item.name}`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); suggestionState.navigate?.(item.id) }}><Icon name="chevron" size={12}/></button>}
              </div>
            ))
          )}</div>
          {suggestionState.type === 'file' && <div className="suggestion-hint">↑↓ 选择 · ↵ 引用 · → 进入 · ← 返回</div>}
        </div>
      )}

      {/* Attachments bar */}
      {attachments.length > 0 && <div className="composer-attachments"><AttachmentCards items={attachments} onRemove={id => setAttachments(items => items.filter(item => item.id !== id))}/></div>}

      {/* Editor Content */}
      <div className="composer-editor-wrap">
        <textarea
          aria-hidden="true"
          tabIndex={-1}
          placeholder={placeholder || '给 Pulse 发送消息…'}
          disabled={disabled}
          value={value}
          onChange={e => {
            const val = e.target.value
            if (editor) {
              editor.commands.setContent(val)
            }
            setHasContent(Boolean(val.trim()))
            onChange(current => ({ ...current, markdown: val, document: editor?.getJSON(), revision: current.revision + 1 }))
          }}
          style={{
            position: 'absolute',
            opacity: 0,
            pointerEvents: 'none',
            height: 0,
            width: 0,
            margin: 0,
            padding: 0,
            border: 'none',
          }}
        />
        <EditorContent editor={editor} id={composerId} />
        {editor && <ComposerBubbleMenu editor={editor}/>}
      </div>

      {/* Bottom compact toolbar */}
      <div className="composer-toolbar">
        <div className="composer-tools-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={e => {
              if (e.target.files?.length) {
                void handleFilesAdded(Array.from(e.target.files))
                e.target.value = ''
              }
            }}
          />
          <Dropdown
            trigger={['click']}
            placement="topLeft"
            open={toolsOpen}
            onOpenChange={setToolsOpen}
            menu={{
              className: 'composer-add-menu',
              items: [
                { key: 'attachment', icon: <Icon name="attachment" size={17} />, label: '添加附件或图片' },
                { key: 'skill', icon: <Icon name="spark" size={17} />, label: 'Skill 技能', extra: '/' },
                { key: 'file', icon: <Icon name="file" size={17} />, label: '引用项目文件', extra: '@', disabled: !projectId },
              ],
              onClick: ({ key }) => {
                setToolsOpen(false)
                if (key === 'attachment') fileInputRef.current?.click()
                else if (editor) editor.chain().focus().insertContent(key === 'skill' ? '/' : '@').run()
              },
            }}
          >
            <button type="button" className="composer-tool-btn composer-add-button"
              aria-label="更多功能" aria-haspopup="menu" aria-expanded={toolsOpen}
              title="添加附件、Skill 或文件引用" disabled={disabled || submitting}>
              <Icon name="plus" size={22} />
            </button>
          </Dropdown>
          {toolbarExtra}
        </div>

        <div className="composer-tools-right">
          {running && (
            <PulseButton
              type="button"
              className="composer-stop-btn"
              aria-label={stopping ? '正在停止' : '停止生成'}
              aria-busy={stopping}
              title={stopping ? '正在停止' : '停止生成'}
              disabled={stopping}
              onClick={onStop}
            >
              <span className={stopping ? 'spinner' : 'composer-stop-icon'} aria-hidden="true" />
            </PulseButton>
          )}
          {running && (hasContent || attachments.length > 0) && <Dropdown trigger={['click']} placement="topRight" open={sendMenuOpen} onOpenChange={setSendMenuOpen} menu={{
            items: [{ key: 'queue', label: '排队发送', extra: followupBehavior === 'queue' ? 'Enter' : '⌘/Ctrl Enter' }, { key: 'immediate', label: '立即发送', extra: followupBehavior === 'immediate' ? 'Enter' : '⌘/Ctrl Enter' }],
            onClick: ({ key }) => { setSendMenuOpen(false); void handleSend(key as FollowupBehavior) },
          }}><button type="button" className="composer-send-menu" aria-label="发送方式" aria-haspopup="menu" aria-expanded={sendMenuOpen} disabled={!canSubmit}><Icon name="down" size={12}/></button></Dropdown>}
          {(!running || hasContent || attachments.length > 0) && <button
            type="button" className="composer-send-btn" disabled={!canSubmit}
            aria-label={submitLabel ?? (running ? followupBehavior === 'queue' ? '加入队列' : '立即发送' : '发送')}
            title={running ? followupBehavior === 'queue' ? '排队发送 · Enter' : '立即发送 · Enter' : '发送 · Enter'}
            onClick={() => void handleSend()}
          >{submitting ? <span className="spinner"/> : <Icon name="up" size={18}/>}</button>}
        </div>
      </div>
    </div>
  )
}
