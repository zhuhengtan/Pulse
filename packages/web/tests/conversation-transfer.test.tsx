import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationTransfer } from '../src/ConversationTransfer.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { PulseWebTransport, WebConversation, WebProject } from '../src/transport.js'

const conversation: WebConversation = { id: 'conv-test', title: '源会话', cwd: '/source', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' }
const projects: WebProject[] = [{ id: 'target', name: '本机项目', cwd: '/target', available: true, pinned: false, createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' }]
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true }); const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element) })
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); URL.createObjectURL = vi.fn(() => 'blob:conversation'); URL.revokeObjectURL = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function Harness({ transport, busy = false, imported = vi.fn(), available = true }: { transport: PulseWebTransport; busy?: boolean; imported?: (conversation: WebConversation) => void; available?: boolean }) {
  const [notice, setNotice] = useState('')
  const controls = useConversationTransfer({ transport, selected: conversation, projects: available ? projects : [], unavailable: busy, onImported: imported, notice: setNotice })
  return <>{controls.exportButton}{controls.importButton}{controls.dialog}<div role="status">{notice}</div></>
}
function fixture(reasons: string[] = []) {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const transport: PulseWebTransport = { async request(path, init) {
    calls.push({ path, ...(init ? { init } : {}) })
    if (path.endsWith('/export')) return new Response('ZIP content', { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="pulse-session.zip"' } })
    if (path === '/api/conversation-imports') return response({ token: 'ticket', conversationId: conversation.id, title: conversation.title, runCount: 2, attachmentCount: 1, activeRunId: 'run-1', blockedReasons: [], redactedFiles: 0 })
    if (init?.method === 'DELETE') return response({ ok: true })
    const body = JSON.parse(String(init?.body ?? '{}'))
    return body.preview ? response({ blockedReasons: reasons }) : response({ conversation, blockedReasons: reasons, duplicate: false })
  }, subscribe() { return () => {} } }
  return { transport, calls }
}
function show(fixture: ReturnType<typeof fixture>, options: { busy?: boolean; imported?: (conversation: WebConversation) => void; available?: boolean } = {}) { return render(<PulseDesignSystem><Harness transport={fixture.transport} {...options}/></PulseDesignSystem>) }
async function upload() { fireEvent.change(screen.getByLabelText('选择会话压缩包'), { target: { files: [new File(['zip'], 'session.zip', { type: 'application/zip' })] } }); await screen.findByText('导入工作会话') }
async function selectProject() { fireEvent.mouseDown(screen.getByRole('combobox', { name: '目标项目' })); fireEvent.click(await screen.findByText('本机项目')); await waitFor(() => expect((screen.getByRole('button', { name: '导入并查看' }) as HTMLButtonElement).disabled).toBe(false)) }

describe('conversation ZIP controls', () => {
  it('downloads a ZIP for the selected conversation and disables export while running', async () => {
    const f = fixture(), click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const view = show(f)
    fireEvent.click(screen.getByRole('button', { name: '导出会话' }))
    await screen.findByText('会话压缩包已交给浏览器下载。')
    expect(f.calls[0]).toMatchObject({ path: '/api/conversations/conv-test/export', init: { method: 'POST' } }); expect(click).toHaveBeenCalledTimes(1)
    view.unmount(); show(f, { busy: true })
    expect((screen.getByRole('button', { name: '导出会话' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('previews an upload, binds an existing project and imports without invoking resume', async () => {
    const f = fixture(), imported = vi.fn(); show(f, { imported })
    await upload()
    expect((screen.getByRole('button', { name: '导入并查看' }) as HTMLButtonElement).disabled).toBe(true)
    await selectProject(); fireEvent.click(screen.getByRole('button', { name: '导入并查看' }))
    await waitFor(() => expect(imported).toHaveBeenCalledWith(conversation))
    expect(f.calls.some(call => call.path.includes('/resume'))).toBe(false)
    expect(f.calls.filter(call => call.path === '/api/conversation-imports/ticket' && call.init?.method === 'POST')).toHaveLength(2)
    expect(f.calls[0]!.init?.body).toBeInstanceOf(File)
  })
  it('shows recovery blockers while still allowing records to be imported', async () => {
    const f = fixture(['WORKSPACE_CONTENT_MISMATCH', 'RECOVERY_SIDE_EFFECT_UNKNOWN']); show(f)
    await upload(); await selectProject()
    await screen.findByText('目标项目文件与源机器执行目录不一致，请先同步项目。')
    await screen.findByText('存在执行结果未知的工具操作，不能自动重试。')
    expect((screen.getByRole('button', { name: '导入并查看' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('cleans up cancelled uploads and keeps import disabled until a project is available', async () => {
    const f = fixture(); show(f, { available: false }); await upload()
    await screen.findByText('请先在历史会话栏添加本机已有项目。')
    expect((screen.getByRole('button', { name: '导入并查看' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(f.calls.some(call => call.path === '/api/conversation-imports/ticket' && call.init?.method === 'DELETE')).toBe(true))
  })
  it('reports upload failures without changing the current conversation', async () => {
    const f = fixture(), imported = vi.fn(); f.transport.request = async () => response({ error: 'BUNDLE_HASH_MISMATCH' }, 400)
    show(f, { imported }); fireEvent.change(screen.getByLabelText('选择会话压缩包'), { target: { files: [new File(['zip'], 'broken.zip')] } })
    await screen.findByText('文件校验失败，压缩包可能损坏或被修改。'); expect(imported).not.toHaveBeenCalled()
  })
})
