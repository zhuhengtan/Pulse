import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { parsePulseRoute, settingsCategories, workUrl, workspaceTabs } from '../src/routing.js'
import { previewKey, savePreviewState } from '../src/previewState.js'
import { followupFixture } from './fixtures/followup.js'
import { routingFixture } from './fixtures/routing.js'

vi.mock('../src/TerminalConsole.js', () => ({ TerminalConsole: ({ terminalId }: { terminalId: string }) => <div>已连接 {terminalId}</div> }))

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const getStyle = window.getComputedStyle.bind(window); window.getComputedStyle = element => getStyle(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('WebSocket', class { close() {} })
})
const routers: ReturnType<typeof createMemoryRouter>[] = []
beforeEach(() => { localStorage.clear(); history.replaceState({}, '', '/') })
afterEach(() => { cleanup(); routers.splice(0).forEach(router => router.dispose()); vi.restoreAllMocks() })
function show(url: string, fixture = routingFixture()) {
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: [url] })
  routers.push(router)
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  return { router, ...fixture, ...view }
}
const address = (router: ReturnType<typeof createMemoryRouter>) => router.state.location.pathname + router.state.location.search
const navigate = async (router: ReturnType<typeof createMemoryRouter>, target: string | number) => { await act(async () => { if (typeof target === 'number') await router.navigate(target); else await router.navigate(target) }) }

describe('explicit URL navigation', () => {
  it.each(['button', 'mask', 'escape'] as const)('closes mobile conversation details via %s without leaving the conversation', async method => {
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(max-width: 767px)', media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList)
    const view = show('/work/pulse-chat')
    await screen.findByText('消息：pulse-chat')
    const trigger = screen.getByRole('button', { name: '对话详情', exact: true })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '对话详情' })
    expect(dialog.closest('.pulse-details-sheet')).toBeTruthy()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(address(view.router)).toContain('details=1')
    if (method === 'button') fireEvent.click(screen.getByRole('button', { name: '关闭', exact: true }))
    else if (method === 'mask') fireEvent.click(document.querySelector('.pulse-details-sheet .ant-drawer-mask')!)
    else fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape', keyCode: 27 })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '对话详情' })).toBeNull())
    expect(address(view.router)).toBe('/work/pulse-chat')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens and hides tabs without losing a document, and keeps export in More and details separate', async () => {
    const view = show('/work/pulse-chat?file=docs%2Fplan.md&workspace=preview')
    await screen.findByText('Verified workspace document')
    const tabs = screen.getByRole('button', { name: '标签页', exact: true })
    expect(tabs.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('button', { name: '工作区', exact: true })).toBeNull()
    fireEvent.click(tabs)
    await waitFor(() => expect(screen.queryByRole('complementary', { name: '标签页' })).toBeNull())
    fireEvent.click(tabs)
    await screen.findByText('Verified workspace document')
    expect(view.calls.some(call => /\/control|\/command/.test(call.path))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '更多', exact: true }))
    expect(await screen.findByRole('menuitem', { name: '导出会话' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '对话详情', exact: true }))
    await screen.findByRole('dialog', { name: '对话详情' })
    expect(view.calls.some(call => call.path.endsWith('/export'))).toBe(false)
  })

  it('keeps existing browser sessions closed initially, then surfaces a newly created internal browser', async () => {
    const original = window.pulseDesktop
    window.pulseDesktop = { nativeBrowser: true } as NonNullable<typeof window.pulseDesktop>
    try {
      const fixture = routingFixture(), request = fixture.transport.request
      let addNew = false, snapshots = 0
      const base = { kind: 'browser', state: 'ai', conversationId: 'pulse-chat', owner: 'run:agent' }
      fixture.transport.request = async (path, init) => path === '/api/automation/sessions'
        ? (snapshots++, Response.json({ sessions: [{ ...base, id: 'external', mode: 'dedicated' }, { ...base, id: 'internal', mode: 'native' }, ...(addNew ? [{ ...base, id: 'new-internal', mode: 'native' }] : [])], nativeBrowser: true, approvalMode: 'ask' }))
        : request(path, init)
      const view = show('/work/pulse-chat', fixture)
      await screen.findByText('消息：pulse-chat')
      await waitFor(() => expect(snapshots).toBeGreaterThan(0))
      expect(new URLSearchParams(view.router.state.location.search).has('workspace')).toBe(false)
      addNew = true
      await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).get('automation')).toBe('new-internal'), { timeout: 4000 })
      expect(new URLSearchParams(view.router.state.location.search).get('workspace')).toBe('preview')
      view.unmount()
    } finally { window.pulseDesktop = original }
  })

  it('normalizes the root and prefers an explicit conversation over saved preferences', async () => {
    const root = show('/')
    await screen.findByText('我们要做什么？'); expect(address(root.router)).toBe('/chat')
    root.unmount(); localStorage.setItem('pulse-web-conversation', 'old')
    const work = show('/work/pulse-chat')
    await screen.findByText('消息：pulse-chat')
    expect(address(work.router)).toBe('/work/pulse-chat')
    expect(work.calls.some(call => call.path === '/api/assistant')).toBe(false)
  })

  it('resolves the work entry to the remembered conversation, or an explicit new draft', async () => {
    localStorage.setItem('pulse-web-conversation', 'pulse-chat')
    const work = show('/work')
    await screen.findByText('消息：pulse-chat'); expect(address(work.router)).toBe('/work/pulse-chat')
    work.unmount(); localStorage.removeItem('pulse-web-conversation')
    const fresh = show('/work')
    await waitFor(() => expect(address(fresh.router)).toBe('/work/new?project=pulse'))
    await screen.findByText('我们要做什么？')
  })

  it('restores conversation selection through back, forward, and remount', async () => {
    const view = show('/work/pulse-chat')
    await screen.findByText('消息：pulse-chat')
    fireEvent.click(screen.getByRole('button', { name: '完善项目记忆' }))
    await screen.findByText('消息：jarvis-chat'); expect(address(view.router)).toBe('/work/jarvis-chat')
    await navigate(view.router, -1); await screen.findByText('消息：pulse-chat')
    await navigate(view.router, 1); await screen.findByText('消息：jarvis-chat')
    const url = address(view.router); view.unmount(); show(url)
    await screen.findByText('消息：jarvis-chat')
  })

  it('keeps project and ungrouped history ordered by pin and update time while selecting, going Back, and going Forward', async () => {
    const fixture = routingFixture(), request = fixture.transport.request
    const base = { cwd: '/example/Pulse', createdAt: '2026-10-18T00:00:00Z' }
    const conversations = [
      { ...base, id: 'newer', title: '较新项目对话', projectId: 'pulse', updatedAt: '2026-10-18T03:00:00Z' },
      { ...base, id: 'old', title: '较旧项目对话', projectId: 'pulse', updatedAt: '2026-10-18T02:00:00Z' },
      { ...base, id: 'pinned', title: '置顶项目对话', projectId: 'pulse', pinned: true, updatedAt: '2026-10-18T01:00:00Z' },
      { ...base, id: 'loose-new', title: '较新未分组对话', updatedAt: '2026-10-18T03:00:00Z' },
      { ...base, id: 'loose-old', title: '较旧未分组对话', updatedAt: '2026-10-18T02:00:00Z' },
    ]
    fixture.transport.request = async (path, init) => path === '/api/conversations' ? new Response(JSON.stringify(conversations)) : request(path, init)
    const view = show('/work/old', fixture)
    const titles = (selector: string) => [...view.container.querySelectorAll(`${selector} .history-item`)].map(button => button.querySelector('span')?.textContent)
    const checkOrder = () => {
      expect(titles('.project-conversations')).toEqual(['置顶项目对话', '较新项目对话', '较旧项目对话'])
      expect(titles('.ungrouped-history')).toEqual(['较新未分组对话', '较旧未分组对话'])
    }
    await screen.findByText('消息：old'); checkOrder()
    fireEvent.click(screen.getByRole('button', { name: '较新项目对话', exact: true }))
    await screen.findByText('消息：newer'); checkOrder()
    fireEvent.click(screen.getByRole('button', { name: '较旧未分组对话', exact: true }))
    await screen.findByText('消息：loose-old'); checkOrder()
    await navigate(view.router, -1); await screen.findByText('消息：newer'); checkOrder()
    await navigate(view.router, 1); await screen.findByText('消息：loose-old'); checkOrder()
    expect(fixture.calls.some(call => call.method === 'PATCH')).toBe(false)
  })

  it('loads archived links and leaves missing conversation URLs intact without selecting another conversation', async () => {
    const view = show('/work/archived')
    await screen.findByText('消息：archived')
    await navigate(view.router, '/work/deleted')
    await screen.findByText('这段对话不存在或已删除。可以选择其他对话。')
    expect(address(view.router)).toBe('/work/deleted')
    expect((screen.getByPlaceholderText('给 Pulse 发送消息…') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.queryByText('消息：archived')).toBeNull()
    expect(view.calls.some(call => call.path === '/api/conversations?archived=1')).toBe(false)
  })

  it('keeps archived deep links working with an older backend until it can be restarted separately', async () => {
    const fixture = routingFixture(), request = fixture.transport.request
    fixture.transport.request = async (path, init) => path === '/api/conversations/archived' ? new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 }) : request(path, init)
    const view = show('/work/archived', fixture)
    await screen.findByText('消息：archived')
    expect(address(view.router)).toBe('/work/archived')
    expect(view.calls.some(call => call.path === '/api/conversations?archived=1')).toBe(true)
  })

  it('replaces the new-draft URL after one creation and one message without restarting it on navigation', async () => {
    const view = show('/work/new?project=pulse')
    await screen.findByText('我们要做什么？')
    fireEvent.change(screen.getByPlaceholderText('给 Pulse 发送消息…'), { target: { value: '实现路由' } })
    fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }))
    await waitFor(() => expect(address(view.router)).toBe('/work/created'))
    await waitFor(() => expect(view.subscriptions).toContain('/api/runs/created-run/events?after=0'))
    expect(view.calls.filter(call => call.path === '/api/conversations' && call.method === 'POST')).toHaveLength(1)
    expect(view.calls.filter(call => call.path === '/api/conversations/created/messages' && call.method === 'POST')).toHaveLength(1)
    await navigate(view.router, '/chat'); await navigate(view.router, -1)
    await screen.findByText('消息：created')
    expect(view.calls.filter(call => call.path === '/api/conversations/created/messages' && call.method === 'POST')).toHaveLength(1)
  })

  it('restores all settings categories and keeps one dirty draft across category history', async () => {
    const view = show('/settings/runtime')
    const input = await screen.findByRole('spinbutton', { name: /^最大执行轮数/ })
    fireEvent.change(input, { target: { value: '40' } }); fireEvent.blur(input)
    for (const category of settingsCategories) {
      await navigate(view.router, `/settings/${category}`)
      expect(view.container.querySelector('h1')).toBeTruthy()
      expect(address(view.router)).toBe(`/settings/${category}`)
    }
    await navigate(view.router, '/settings/runtime')
    expect((await screen.findByRole('spinbutton', { name: /^最大执行轮数/ }) as HTMLInputElement).value).toBe('40')
    expect(view.calls.filter(call => call.path === '/api/config')).toHaveLength(1)
    expect(view.calls.some(call => call.method === 'PUT')).toBe(false)
  })

  it('blocks browser Back and page close for invalid JSON, preserving URL and text on cancel', async () => {
    const view = show('/chat'); await screen.findByText('我们要做什么？')
    fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '高级配置', exact: true }))
    const text = await screen.findByRole('textbox', { name: /完整配置/ })
    fireEvent.change(text, { target: { value: '{ invalid' } })
    await navigate(view.router, -1) // Same settings draft, category list.
    await navigate(view.router, -1) // Leaves settings and must be blocked.
    fireEvent.click(await screen.findByRole('button', { name: '取消', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(address(view.router)).toBe('/settings')
    fireEvent.click(screen.getByRole('button', { name: '高级配置', exact: true }))
    expect((await screen.findByRole('textbox', { name: /完整配置/ }) as HTMLTextAreaElement).value).toBe('{ invalid')
    fireEvent.click(screen.getAllByRole('button', { name: '返回聊天' })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
    await screen.findByText('我们要做什么？'); expect(address(view.router)).toBe('/chat')
  })

  it('opens legacy file links as document tabs and restores them through history without reloading messages', async () => {
    const view = show('/work/pulse-chat?workspace=files&path=docs&file=docs%2Fplan.md&offset=1000')
    await screen.findByText('Verified workspace document')
    expect(view.calls.some(call => call.path.includes('/file-raw?path=docs%2Fplan.md'))).toBe(true)
    expect(screen.getByRole('tab', { name: 'plan.md', exact: true }).getAttribute('aria-selected')).toBe('true')
    await navigate(view.router, '/work/pulse-chat?workspace=files&path=docs')
    await screen.findByText('plan.md', { selector: '.workspace-file-title strong' })
    await navigate(view.router, -1); await screen.findByText('Verified workspace document')
    expect(view.calls.filter(call => call.path === '/api/web/conversations/pulse-chat/messages')).toHaveLength(1)
  })

  it('restores all workspace tabs, Git stage and selected diff without invoking host actions', async () => {
    const view = show('/work/pulse-chat?workspace=git&staged=1&diff=staged.ts')
    await screen.findByText('+verified diff')
    expect(view.calls.some(call => call.path.includes('/git/diff?path=staged.ts&staged=1'))).toBe(true)
    for (const tab of workspaceTabs.filter(value => value !== 'preview' && value !== 'automation')) {
      await navigate(view.router, `/work/pulse-chat?workspace=${tab}`)
      await waitFor(() => expect(screen.getByRole('tab', { name: { files: '文件', git: '变更', terminal: '终端', automation: '自动化' }[tab], exact: true }).getAttribute('aria-selected')).toBe('true'))
    }
    expect(view.calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual(['/api/session/local'])
  })

  it('restores automation, details and artifact positions while ignoring retired task links', async () => {
    const view = show('/work/pulse-chat?workspace=automation&automation=browser-1&task=1&lane=main&artifact=reports%2Fexample-report.txt&artifactRun=fixture-run')
    await waitFor(() => expect(screen.getByRole('region', { name: '预览 reports/example-report.txt' }).textContent).toContain('这是用于检查交付文件预览'))
    expect(screen.queryByRole('button', { name: '任务状态' })).toBeNull()
    expect(screen.queryByRole('button', { name: '关闭任务状态' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'example-report.txt', exact: true })).toBeTruthy()
    expect(view.calls.some(call => /\/control|\/observe/.test(call.path))).toBe(false)
    await navigate(view.router, '/work/pulse-chat?details=1')
    await screen.findByRole('dialog', { name: '对话详情' })
    expect(screen.queryByRole('button', { name: '关闭任务状态' })).toBeNull()
  })

  it('restores a chosen document without a retained browser stealing focus after reload', async () => {
    const target = { kind: 'file' as const, path: 'README.md', projectId: 'pulse' }
    savePreviewState('pulse-chat', [target], previewKey(target))
    const fixture = routingFixture(), request = fixture.transport.request
    fixture.transport.request = async (path, init) => path === '/api/automation/sessions'
      ? Response.json({ sessions: [{ id:'kept', kind:'browser', state:'human', owner:'conversation:pulse-chat', conversationId:'pulse-chat' }], enabled:['browser'], approvalMode:'ask' })
      : request(path, init)
    const view = show('/work/pulse-chat?workspace=preview', fixture)
    await screen.findByText('Verified workspace document')
    expect(screen.getByRole('tab', { name:'README.md', exact:true }).getAttribute('aria-selected')).toBe('true')
    expect(address(view.router)).not.toContain('automation=')
    expect(view.calls.some(call => /\/control|\/observe/.test(call.path))).toBe(false)
  })

  it('reconnects a running conversation on refresh without any task mutation', async () => {
    const view = show('/work/busy?task=1')
    await screen.findByText('消息：busy')
    await waitFor(() => expect(view.subscriptions).toHaveLength(1))
    expect(view.calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual(['/api/session/local'])
  })

  it('restores the chosen existing terminal and its history without creating a process', async () => {
    const view = show('/work/pulse-chat?workspace=terminal&terminal=term-2', routingFixture({ canUseTerminal: true }))
    // This route test covers async lazy-module readiness, not a 1s render SLA.
    await screen.findByText('已连接 term-2', {}, { timeout: 4000 })
    expect(view.container.querySelector('.terminal-stage:not([hidden])')?.textContent).toBe('已连接 term-2')
    fireEvent.click(screen.getByRole('button', { name: '终端 1', exact: true }))
    await waitFor(() => expect(view.router.state.location.search).toContain('terminal=term-1'))
    await navigate(view.router, -1)
    expect(view.container.querySelector('.terminal-stage:not([hidden])')?.textContent).toBe('已连接 term-2')
    expect(view.calls.some(call => call.path === '/api/terminals' && call.method === 'POST')).toBe(false)
  })

  it.each(['/chat', '/work/old'])('ignores late data from %s after navigating to a different conversation', async initial => {
    const fixture = routingFixture(), request = fixture.transport.request
    let resolve!: () => void
    const delayed = initial === '/chat' ? '/api/assistant' : '/api/web/conversations/old/messages'
    fixture.transport.request = async (path, init) => {
      if (path === delayed) await new Promise<void>(done => { resolve = done })
      return request(path, init)
    }
    const view = show(initial, fixture)
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    await navigate(view.router, '/work/pulse-chat'); await screen.findByText('消息：pulse-chat')
    await act(async () => { resolve() })
    expect(address(view.router)).toBe('/work/pulse-chat')
    expect(screen.getByText('消息：pulse-chat')).toBeTruthy()
    expect(screen.queryByText('消息：old')).toBeNull()
  })

  it('routes the old pairing entry to device settings without generating a QR automatically', async () => {
    const view = show('/pair')
    await screen.findByRole('heading', { name: '设备管理', exact: true })
    expect(address(view.router)).toBe('/settings/devices')
    expect(screen.getByRole('button', { name: '扫码连接', exact: true })).toBeTruthy()
    expect(view.calls.some(call => call.path === '/api/pair/qr')).toBe(false)
  })

  it('consumes a pairing code once, removes only that parameter, and keeps the deep link', async () => {
    const view = show('/work/pulse-chat?workspace=files&file=README.md&code=TEST1234')
    await screen.findByText('Verified workspace document')
    expect(address(view.router)).toBe('/work/pulse-chat?workspace=files&file=README.md')
    expect(view.calls.filter(call => call.path === '/api/pair')).toHaveLength(1)
    expect(view.calls.some(call => call.path === '/api/assistant')).toBe(false)
  })

  it('returns from settings and archive to the source workspace position', async () => {
    const initial = '/work/pulse-chat?workspace=git&diff=both.ts'
    const view = show(initial); await screen.findByText('+verified diff')
    fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '模型与服务商', exact: true }))
    fireEvent.click(screen.getAllByRole('button', { name: '返回聊天' })[0]!)
    await waitFor(() => expect(address(view.router)).toBe(initial))
    fireEvent.click(screen.getByRole('button', { name: '归档对话', exact: true }))
    await screen.findByRole('heading', { name: '归档对话' })
    fireEvent.click(screen.getByRole('button', { name: '返回聊天' }))
    await waitFor(() => expect(address(view.router)).toBe(initial))
  })

  it('preserves the source through nested settings/archive navigation and uses history for category Back', async () => {
    const initial = '/work/pulse-chat?task=1'
    const view = show(initial); await screen.findByText('消息：pulse-chat')
    fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '归档对话', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '打开归档对话', exact: true }))
    await screen.findByRole('heading', { name: '归档对话' })
    fireEvent.click(screen.getByRole('button', { name: '返回聊天' }))
    await waitFor(() => expect(address(view.router)).toBe('/settings/archive'))
    fireEvent.click(screen.getAllByRole('button', { name: '返回聊天' })[0]!)
    await waitFor(() => expect(address(view.router)).toBe(initial.replace('?task=1', '')))
    fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '模型与服务商', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: /分类/ }))
    expect(address(view.router)).toBe('/settings')
    await navigate(view.router, -1)
    await waitFor(() => expect(address(view.router)).toBe(initial.replace('?task=1', '')))
  })

  it('shows authentication failures on a settings deep link and retries without losing its category', async () => {
    const fixture = routingFixture(), request = fixture.transport.request
    let denied = true
    fixture.transport.request = async (path, init) => denied ? new Response('{}', { status: 401 }) : request(path, init)
    const view = show('/settings/models', fixture)
    await screen.findByText('设备尚未授权。请在本机打开 Pulse，或重新扫码配对。')
    denied = false; fireEvent.click(screen.getByRole('button', { name: '重试', exact: true }))
    await screen.findByRole('heading', { name: '模型与服务商', exact: true })
    expect(address(view.router)).toBe('/settings/models')
  })

  it('shows missing pages/projects and safely parses malformed or unrelated query parameters', async () => {
    const view = show('/work/new?project=deleted')
    await screen.findByText('这个项目不存在或已移除，请选择其他项目。')
    await navigate(view.router, '/settings/not-a-category'); await screen.findByText('页面不存在')
    const route = parsePulseRoute('/work/busy', '?file=..%2Fsecret&offset=-2&workspace=nope&token=secret&task=1')
    expect(route.query.toString()).toBe('')
    expect(parsePulseRoute('/work/%E0%A4%A').page).toBe('missing')
    expect(workUrl(undefined, '项目 & 1')).toBe('/work/new?project=%E9%A1%B9%E7%9B%AE+%26+1')
  })

  it('loads the project catalog while the conversation directory is still pending', async () => {
    const fixture = routingFixture(), request = fixture.transport.request
    let release!: () => void, projectsRequested = false
    const barrier = new Promise<void>(resolve => { release = resolve })
    fixture.transport.request = async (path, init) => {
      if (path === '/api/conversations') await barrier
      if (path === '/api/projects') projectsRequested = true
      return request(path, init)
    }
    show('/work/pulse-chat?workspace=files&file=README.md', fixture)
    await waitFor(() => expect(projectsRequested).toBe(true))
    release()
    await screen.findByText('Verified workspace document')
  })

  it('keeps a mobile history drawer opened during a slow conversation load', async () => {
    const original = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation(query => query === '(max-width: 767px)' ? { matches: true, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList : original(query))
    const fixture = routingFixture(), request = fixture.transport.request
    let resolve!: () => void
    fixture.transport.request = async (path, init) => {
      if (path === '/api/web/conversations/pulse-chat/messages') await new Promise<void>(done => { resolve = done })
      return request(path, init)
    }
    const view = show('/work/pulse-chat', fixture)
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('button', { name: '历史对话', exact: true }))
    await waitFor(() => expect(view.baseElement.querySelector('.ant-drawer-open')).toBeTruthy())
    await act(async () => { resolve() })
    expect(view.baseElement.querySelector('.ant-drawer-open')).toBeTruthy()
  })
})

it('opens a pending plan in the right dock using its exact run instead of the unmerged project file', async () => {
  const fixture = followupFixture('work', true), original = fixture.transport.request
  const path = 'docs/plans/feature.md', runId = fixture.conversation.activeRunId!
  fixture.transport.request = async (url, init) => {
    if (url.endsWith('/state')) return Response.json({ runId, state: 'running', seq: 0, activities: [], interactions: [{ groupId: 'plan-group', kind: 'ask', items: [{ effectId: 'plan-question', input: { type: 'choice', prompt: `请审阅已保存的计划 ${path}，是否执行？`, options: [{ value: 'defer', label: '暂不执行' }, { value: 'execute', label: '执行' }] } }] }] })
    if (url.includes('/artifacts/raw?')) return new Response('# Pending plan preview\n\nRead before executing.', { headers: { 'Content-Type': 'text/markdown' } })
    return original(url, init)
  }
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: ['/work/busy'] })
  routers.push(router)
  const view = render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  try {
    fireEvent.click(await view.findByRole('button', { name: path }))
    expect(new URLSearchParams(router.state.location.search).get('workspace')).toBe('preview')
    expect(new URLSearchParams(router.state.location.search).get('artifactRun')).toBe(runId)
    await view.findByRole('heading', { name: 'Pending plan preview' })
    expect(fixture.calls.filter(call => call.path.endsWith('/replies'))).toHaveLength(0)
  } finally { view.unmount() }
})
