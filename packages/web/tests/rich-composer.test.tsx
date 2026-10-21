import { useState } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { RichComposer, emptyComposerDraft, type ComposerDraft, type ComposerPayload } from '../src/RichComposer.js'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const transport = { request: vi.fn(async (path: string) => Response.json(path.includes('skills') ? { skills: [{ id: 'grill-and-plan', name: 'grill-and-plan' }] } : { paths: ['中文目录/a.ts'] })), subscribe: () => () => {} }
const editorOf = (view: ReturnType<typeof render>) => (view.container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
function Harness({ send, running = false, mode = 'work', disabled = false }: { send: (payload: ComposerPayload) => Promise<boolean>; running?: boolean; mode?: 'work' | 'chat'; disabled?: boolean }) {
  const [key, setKey] = useState('A')
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({})
  return <><button onClick={() => setKey(key === 'A' ? 'B' : 'A')}>切换会话</button><RichComposer key={key} draft={drafts[key] ?? emptyComposerDraft()} onChange={update => setDrafts(current => ({ ...current, [key]: update(current[key] ?? emptyComposerDraft()) }))} projectId={key} surfaceMode={mode} running={running} transport={transport} onSend={send} disabled={disabled} placeholder={disabled ? '请先授权此设备' : '给 Pulse 发送消息…'} /></>
}
it.each([false, true])('clears draft only when delivery is accepted=%s', async accepted => {
  let resolve!: (accepted: boolean) => void
  const send = vi.fn(() => new Promise<boolean>(r => { resolve = r }))
  const view = render(<Harness send={send} />)
  act(() => editorOf(view).commands.insertContent('不能丢失的草稿'))
  fireEvent.click(view.getByRole('button', { name: '发送' }))
  expect(editorOf(view).getText()).toBe('不能丢失的草稿')
  await act(async () => resolve(accepted))
  expect(editorOf(view).getText()).toBe(accepted ? '' : '不能丢失的草稿')
})
it('does not clear later edits after an earlier send completes', async () => {
  let resolve!: (value: boolean) => void
  const view = render(<Harness send={() => new Promise(r => { resolve = r })} />)
  act(() => editorOf(view).commands.insertContent('第一条'))
  fireEvent.click(view.getByRole('button', { name: '发送' }))
  act(() => editorOf(view).commands.insertContent('补充'))
  await act(async () => resolve(true))
  expect(editorOf(view).getText()).toBe('第一条补充')
})
it('isolates attachment drafts and restores structured skill/file chips', async () => {
  const send = vi.fn(async () => false)
  const view = render(<Harness send={send} />)
  act(() => editorOf(view).commands.insertContent([{ type: 'skillChip', attrs: { id: 'grill-and-plan', label: 'grill-and-plan' } }, { type: 'text', text: ' ' }, { type: 'fileChip', attrs: { id: '中文目录/a.ts', label: '中文目录/a.ts' } }]))
  fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['A 的内容'], 'a.txt', { type: 'text/plain' })] } })
  await view.findByText('a.txt')
  fireEvent.click(view.getByText('切换会话'))
  expect(view.queryByText('a.txt')).toBeNull()
  act(() => editorOf(view).commands.insertContent('B 的内容'))
  fireEvent.click(view.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(send.mock.calls[0]![0].attachments).toBeUndefined()
  fireEvent.click(view.getByText('切换会话'))
  expect(await view.findByText('a.txt')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  expect(send.mock.calls[1]![0]).toMatchObject({ skills: ['grill-and-plan'], mentionedFiles: expect.arrayContaining(['中文目录/a.ts']), attachments: [{ name: 'a.txt' }] })
})
it('routes a late send and late file read to their originating draft', async () => {
  let reader!: FileReader
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function(this: FileReader) { reader = this })
  const send = vi.fn(async () => true)
  const view = render(<Harness send={send} />)
  fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'late.txt', { type: 'text/plain' })] } })
  expect((view.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(view.getByText('切换会话'))
  await act(async () => {
    Object.defineProperty(reader, 'result', { value: 'data:text/plain;base64,eA==' })
    reader.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>)
  })
  expect(view.queryByText('late.txt')).toBeNull()
  fireEvent.click(view.getByText('切换会话'))
  expect(await view.findByText('late.txt')).toBeTruthy()
})
it.each(['Skill 技能', '引用项目文件'])('opens %s from the add menu and accepts keyboard/mouse selection', async label => {
  const view = render(<Harness send={async () => false} />)
  fireEvent.click(view.getByRole('button', { name: '更多功能' }))
  fireEvent.click(await view.findByRole('menuitem', { name: label === 'Skill 技能' ? /Skill 技能/ : /引用项目文件/ }))
  const menu = await view.findByRole('listbox')
  expect(menu.textContent).toContain(label === 'Skill 技能' ? 'grill-and-plan' : '中文目录/a.ts')
  if (label === 'Skill 技能') fireEvent.keyDown(view.container.querySelector('.tiptap')!, { key: 'Enter' })
  else fireEvent.mouseDown(view.getByRole('option'))
  await waitFor(() => expect(view.queryByRole('listbox')).toBeNull())
  expect(editorOf(view).getJSON().content?.[0]?.content?.[0]?.type).toBe(label === 'Skill 技能' ? 'skillChip' : 'fileChip')
})
it('updates placeholder after authorization', async () => {
  const send = async () => false
  const view = render(<Harness send={send} disabled />)
  expect(view.container.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe('请先授权此设备')
  view.rerender(<Harness send={send} />)
  await waitFor(() => expect(view.container.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe('给 Pulse 发送消息…'))
  expect(view.container.querySelector('.tiptap')?.getAttribute('contenteditable')).toBe('true')
})
it.each(['chat', 'work'] as const)('allows assistant queue but blocks concurrent work: %s', async mode => {
  const send = vi.fn(async () => true)
  const view = render(<Harness send={send} running mode={mode} />)
  act(() => editorOf(view).commands.insertContent('第二条消息'))
  if (mode === 'work') expect(view.queryByRole('button', { name: '发送' })).toBeNull()
  fireEvent.keyDown(view.container.querySelector('.tiptap')!, { key: 'Enter' })
  if (mode === 'chat') await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  else expect(send).not.toHaveBeenCalled()
})

it.each(['paste', 'drop'])('handles actual editor %s events as attachments instead of editor text', async action => {
  const view = render(<Harness send={async () => false} />)
  const file = new File(['事件中的附件内容'], `${action}.txt`, { type: 'text/plain' })
  const target = view.container.querySelector('.tiptap')!
  if (action === 'paste') fireEvent.paste(target, { clipboardData: { files: [file], getData: () => '' } })
  else fireEvent.drop(target, { dataTransfer: { files: [file], getData: () => '' } })
  expect(await view.findByText(`${action}.txt`)).toBeTruthy()
  expect(editorOf(view).getText()).toBe('')
})
it('reserves pending file slots across overlapping additions and caps the resulting draft at ten', async () => {
  const readers: FileReader[] = []
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function(this: FileReader) { readers.push(this) })
  const view = render(<Harness send={async () => false} />)
  const input = view.container.querySelector('input[type=file]')!
  const files = (prefix: string) => Array.from({ length: 6 }, (_, i) => new File(['x'], `${prefix}-${i}.txt`, { type: 'text/plain' }))
  fireEvent.change(input, { target: { files: files('A') } })
  fireEvent.change(input, { target: { files: files('B') } })
  for (let n = 0; n < 10; n++) {
    await act(async () => {
      const reader = readers[n]!
      Object.defineProperty(reader, 'result', { value: 'data:text/plain;base64,eA==' })
      reader.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>)
    })
  }
  expect(view.container.querySelectorAll('.composer-attachment-item')).toHaveLength(10)
  expect(view.queryByText('正在处理附件…')).toBeNull()
})

it('clears only the original conversation after a late accepted send', async () => {
  let resolve!: (value: boolean) => void
  const view = render(<Harness send={() => new Promise(r => { resolve = r })} />)
  act(() => editorOf(view).commands.insertContent('A 原始消息'))
  fireEvent.click(view.getByRole('button', { name: '发送' }))
  fireEvent.click(view.getByText('切换会话'))
  act(() => editorOf(view).commands.insertContent('B 新草稿'))
  await act(async () => resolve(true))
  expect(editorOf(view).getText()).toBe('B 新草稿')
  fireEvent.click(view.getByText('切换会话'))
  expect(editorOf(view).getText()).toBe('')
})
it('rejects an oversized complete payload without clearing its attachment', async () => {
  const send = vi.fn(async () => true)
  const draft: ComposerDraft = { ...emptyComposerDraft(), attachments: [{ id: 'large', name: 'large.txt', type: 'file', size: 1, mediaType: 'text/plain', data: 'x'.repeat(35 * 1024 * 1024) }] }
  const update = vi.fn()
  const view = render(<RichComposer draft={draft} onChange={update} surfaceMode="chat" transport={transport} onSend={send} />)
  fireEvent.click(view.getByRole('button', { name: '发送' }))
  expect(await view.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('单次发送上限'))
  expect(send).not.toHaveBeenCalled()
  expect(view.getByText('large.txt')).toBeTruthy()
})
