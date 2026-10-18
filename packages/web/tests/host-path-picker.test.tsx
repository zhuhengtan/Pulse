import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HostPathPicker } from '../src/HostPathPicker.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { PulseApp } from './RouterApp.js'
import { sidebarFixture } from './fixtures/sidebar.js'
import { hostPathFixture, pathResponse } from './fixtures/host-paths.js'
import type { PulseWebTransport } from '../src/transport.js'
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const getStyle = window.getComputedStyle.bind(window); window.getComputedStyle = element => getStyle(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); window.localStorage.clear() })
async function show(mode: 'directory' | 'file' | 'both' = 'directory', transport?: PulseWebTransport) {
  const fixture = hostPathFixture(); const onConfirm = vi.fn(); const onCancel = vi.fn()
  const view = render(<PulseDesignSystem><HostPathPicker open mode={mode} allowCreateDirectory transport={transport ?? fixture.transport} onConfirm={onConfirm} onCancel={onCancel} /></PulseDesignSystem>)
  await screen.findByRole('button', { name: '打开文件夹：中文 项目' })
  return { ...view, ...fixture, onConfirm, onCancel }
}
describe('controlled host path picker', () => {
  it('uses canonical host paths and supports directory navigation and cancellation', async () => {
    const view = await show()
    fireEvent.click(screen.getByRole('button', { name: '打开文件夹：中文 项目' }))
    await screen.findByText('当前文件夹：/host/中文 项目')
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    expect(view.onConfirm).toHaveBeenCalledWith({ path: '/host/中文 项目', kind: 'directory' })
    fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }))
    expect(view.onCancel).toHaveBeenCalledOnce()
    expect(view.calls.some(call => call.path.includes('select-directory'))).toBe(false)
  })
  it('requires a file selection in file mode, shows hidden items, disables broken links', async () => {
    const view = await show('file')
    expect((screen.getByRole('button', { name: '选择此文件夹' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '选择文件：broken（不可用）' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: '显示隐藏项' }))
    await screen.findByRole('button', { name: '选择文件：.hidden' })
    fireEvent.click(screen.getByRole('button', { name: '选择文件：note.txt' }))
    fireEvent.click(screen.getByRole('button', { name: '选择文件', exact: true }))
    expect(view.onConfirm).toHaveBeenCalledWith({ path: '/host/note.txt', kind: 'file' })
  })
  it('creates empty folders through the host and preserves conflict input for correction', async () => {
    const view = await show('both')
    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新文件夹名称' }), { target: { value: 'exists' } })
    fireEvent.click(screen.getByRole('button', { name: '创建', exact: true }))
    await screen.findByRole('alert')
    expect((screen.getByRole('textbox', { name: '新文件夹名称' }) as HTMLInputElement).value).toBe('exists')
    fireEvent.change(screen.getByRole('textbox', { name: '新文件夹名称' }), { target: { value: '中文 空格' } })
    fireEvent.click(screen.getByRole('button', { name: '创建', exact: true }))
    await screen.findByText('当前文件夹：/host/中文 空格')
    expect(view.made).toEqual(['/host/中文 空格'])
    fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }))
    expect(view.onConfirm).not.toHaveBeenCalled()
  })
  it('reports permission errors and prevents confirming a previous directory', async () => {
    await show()
    fireEvent.change(screen.getByRole('textbox', { name: '电脑绝对路径' }), { target: { value: '/forbidden' } })
    fireEvent.click(screen.getByRole('button', { name: '前往' }))
    await screen.findByText('电脑不允许访问此目录，请选择其他目录。')
    expect((screen.getByRole('button', { name: '选择此文件夹' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '主目录' }))
    await screen.findByText('当前文件夹：/host')
  })
  it('aborts on close and ignores a late response after reopening', async () => {
    const fixture = hostPathFixture(); let finish!: (response: Response) => void; let signal: AbortSignal | null | undefined
    const transport: PulseWebTransport = { ...fixture.transport, request: (path, init) => {
      if (path.includes('path=%2Fslow')) { signal = init?.signal; return new Promise(resolve => { finish = resolve }) }
      return fixture.transport.request(path, init)
    } }
    const onConfirm = vi.fn(); const onCancel = vi.fn()
    const element = (open: boolean) => <PulseDesignSystem><HostPathPicker open={open} mode="directory" transport={transport} onConfirm={onConfirm} onCancel={onCancel} /></PulseDesignSystem>
    const view = render(element(true)); await screen.findByText('当前文件夹：/host')
    fireEvent.change(screen.getByRole('textbox', { name: '电脑绝对路径' }), { target: { value: '/slow' } }); fireEvent.click(screen.getByRole('button', { name: '前往' }))
    view.rerender(element(false)); expect(signal?.aborted).toBe(true)
    view.rerender(element(true)); await screen.findByText('当前文件夹：/host')
    finish(pathResponse(fixture.listing('/slow', [])))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '电脑绝对路径' }) as HTMLInputElement).value).toBe('/host'))
    expect(screen.queryByText('当前文件夹：/slow')).toBeNull()
  })
  it('appends pages without losing directory context', async () => {
    const fixture = hostPathFixture()
    const transport: PulseWebTransport = { ...fixture.transport, request: (path, init) => {
      if (path.includes('/entries?')) return Promise.resolve(pathResponse({ ...fixture.listing('/host', [{ name: path.includes('offset=200') ? 'second' : 'first', path: path.includes('offset=200') ? '/host/second' : '/host/first', kind: 'file' }]), nextOffset: path.includes('offset=200') ? null : 200 }))
      return fixture.transport.request(path, init)
    } }
    render(<PulseDesignSystem><HostPathPicker open mode="both" transport={transport} onConfirm={vi.fn()} onCancel={vi.fn()} /></PulseDesignSystem>)
    await screen.findByRole('button', { name: '选择文件：first' }); fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await screen.findByRole('button', { name: '选择文件：second' }); expect(screen.getByRole('button', { name: '选择文件：first' })).toBeTruthy()
  })
})
describe('paired phone project registration', () => {
  it('enables only host browsing/registration, cancels safely and registers the chosen canonical directory', async () => {
    const sidebar = sidebarFixture(); const paths = hostPathFixture(); const registered: unknown[] = []
    const transport: PulseWebTransport = { ...sidebar.transport, request: (path, init) => {
      if (path === '/api/session') return Promise.resolve(pathResponse({ localAdmin: false, canUseTerminal: false, canBrowseHostPaths: true, canRegisterProject: true }))
      if (path.startsWith('/api/host-filesystem/')) return paths.transport.request(path, init)
      if (path === '/api/projects' && init?.method === 'POST') { const body = JSON.parse(String(init.body)); registered.push(body); return Promise.resolve(pathResponse({ id: 'mobile', ...body, available: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, 201)) }
      return sidebar.transport.request(path, init)
    } }
    render(<PulseDesignSystem><PulseApp transport={transport} /></PulseDesignSystem>)
    await screen.findByText('我们要做什么？'); fireEvent.click(screen.getByRole('tab', { name: '工作' }))
    fireEvent.click(await screen.findByRole('button', { name: '添加电脑项目' })); await screen.findByText('当前文件夹：/host')
    fireEvent.click(screen.getByRole('button', { name: '取消', exact: true })); expect(registered).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '添加电脑项目' })); await screen.findByText('当前文件夹：/host')
    fireEvent.click(screen.getByRole('button', { name: '打开文件夹：中文 项目' })); await screen.findByText('当前文件夹：/host/中文 项目')
    fireEvent.click(screen.getByRole('button', { name: '选择此文件夹' }))
    const name = await screen.findByRole('textbox', { name: '项目名称' }); fireEvent.change(name, { target: { value: '手机项目' } })
    fireEvent.click(screen.getByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect(registered).toEqual([{ name: '手机项目', cwd: '/host/中文 项目' }]))
    await screen.findByRole('button', { name: '折叠项目：手机项目' })
  })
})
