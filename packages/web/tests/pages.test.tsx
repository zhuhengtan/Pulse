import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { SettingsPage } from '../src/SettingsPage.js'
import { InteractionPanel } from '../src/PulseApp.js'
import { PulseApp } from './RouterApp.js'
import { settingsFixture } from './fixtures/settings.js'
import { sidebarFixture } from './fixtures/sidebar.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const style = window.getComputedStyle.bind(window)
  window.getComputedStyle = element => style(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => window.localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('page navigation and recovery', () => {
  it('visits every settings category without changing configuration or invoking host actions', async () => {
    const fixture = settingsFixture()
    render(<PulseDesignSystem><SettingsPage transport={fixture.transport} canEditConfig onClose={() => {}}/></PulseDesignSystem>)
    for (const name of ['外观','模型与服务商','模型路由','即时预回复','审批与代审','Jarvis','工具与技能','MCP','网络','指令','运行与存储','归档对话','高级配置']) {
      fireEvent.click(screen.getByRole('button', { name, exact: true }))
      expect(await screen.findByRole('heading', { name, exact: true, level: 1 })).toBeTruthy()
    }
    expect(fixture.writes).toEqual([])
  })

  it('keeps an edited numeric draft on cancel and restores it only after explicit confirmation', async () => {
    const fixture = settingsFixture()
    render(<PulseDesignSystem><SettingsPage transport={fixture.transport} canEditConfig onClose={() => {}}/></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('button', { name: '运行与存储', exact: true }))
    const input = await screen.findByRole('spinbutton', { name: /^最大执行轮数/ })
    fireEvent.change(input, { target: { value: '40' } })
    fireEvent.blur(input)
    fireEvent.click(screen.getByRole('button', { name: '取消修改', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '取消', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((input as HTMLInputElement).value).toBe('40')
    fireEvent.click(screen.getByRole('button', { name: '取消修改', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('32'))
    expect(fixture.writes).toEqual([])
  })

  it('scans model rows first and preserves unsaved edits across drawer close and reopen', async () => {
    const fixture = settingsFixture()
    render(<PulseDesignSystem><SettingsPage transport={fixture.transport} canEditConfig onClose={() => {}}/></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('button', { name: '模型与服务商', exact: true }))
    expect(await screen.findByRole('button', { name: '编辑模型 示例模型' })).toBeTruthy()
    expect(screen.queryByLabelText('模型代码')).toBeNull()
    expect(screen.queryByLabelText('服务地址')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑模型 示例模型' }))
    const input = await screen.findByLabelText('模型代码')
    fireEvent.change(input, { target: { value: 'draft-model' } })
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    await waitFor(() => expect(screen.queryByLabelText('模型代码')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '编辑模型 示例模型' }))
    expect(await screen.findByLabelText('模型代码')).toHaveProperty('value', 'draft-model')
    expect(fixture.writes).toEqual([])
    expect(screen.getByRole('button', { name: '保存全部' })).not.toHaveProperty('disabled', true)
  })

  it('keeps the explicit Responses choice in the provider draft and clears it when switching to a native vendor', async () => {
    const fixture = settingsFixture()
    render(<PulseDesignSystem><SettingsPage transport={fixture.transport} canEditConfig onClose={() => {}}/></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('button', { name: '模型与服务商', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '高级编辑服务商 示例服务商' }))
    const mode = screen.getByRole('combobox', { name: /^API 格式/ })
    fireEvent.mouseDown(mode)
    fireEvent.click(await screen.findByText('Responses', { selector: '.ant-select-item-option-content' }))
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }))
    await waitFor(() => expect(screen.queryByRole('combobox', { name: /^API 格式/ })).toBeNull())
    expect(screen.getByText('sample · openai-compatible · Responses')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '高级编辑服务商 示例服务商' }))
    expect(screen.getByRole('combobox', { name: /^API 格式/ }).closest('.ant-select')?.textContent).toContain('Responses')
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /^协议类型/ }))
    fireEvent.click(await screen.findByText('anthropic', { selector: '.ant-select-item-option-content' }))
    expect(screen.queryByRole('combobox', { name: /^API 格式/ })).toBeNull()
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /^协议类型/ }))
    fireEvent.click(await screen.findByText('openai-compatible', { selector: '.ant-select-item-option-content' }))
    expect(screen.getByRole('combobox', { name: /^API 格式/ }).closest('.ant-select')?.textContent).toContain('Chat Completions')
    expect(fixture.writes).toEqual([])
  })

  it('opens a newly added model even beyond the current page and clears list filters', async () => {
    const fixture = settingsFixture()
    fixture.config.providers.sample.models = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i ? `existing-${i}` : 'chat', { displayName: `Existing ${i}`, modelCode: `code-${i}` }])) as typeof fixture.config.providers.sample.models
    render(<PulseDesignSystem><SettingsPage transport={fixture.transport} canEditConfig category="models" onClose={() => {}}/></PulseDesignSystem>)
    fireEvent.click(await screen.findByRole('button', { name: '模型与服务商', exact: true }))
    const search = await screen.findByLabelText('搜索已配置模型')
    fireEvent.change(search, { target: { value: 'Existing' } })
    fireEvent.click(screen.getAllByRole('button', { name: '＋ 添加模型', exact: true })[0]!)
    expect(await screen.findByLabelText('模型代码')).toHaveProperty('value', '')
    expect(search).toHaveProperty('value', '')
    expect(fixture.writes).toEqual([])
  })

  it('shows a failed image probe in an Ant Design dialog without saving the draft', async () => {
    const fixture = settingsFixture()
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<PulseDesignSystem><SettingsPage transport={fixture.transport} canEditConfig onClose={() => {}}/></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('button', { name: '模型与服务商', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑模型 示例模型', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '检测已保存模型的图像输入', exact: true }))
    expect((await screen.findAllByRole('dialog')).length).toBeGreaterThan(0)
    expect(screen.getByText(/图像协议检测失败/)).toBeTruthy()
    expect(alert).not.toHaveBeenCalled()
    expect(fixture.writes).toEqual([{ path: '/api/automation/vision-probe', method: 'POST' }])
    fireEvent.click(screen.getByRole('button', { name: '知道了', exact: true }))
  })

  it('recovers invalid advanced JSON by formatting or explicitly cancelling the draft', async () => {
    const fixture = settingsFixture()
    render(<PulseDesignSystem><SettingsPage transport={fixture.transport} canEditConfig onClose={() => {}}/></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('button', { name: '高级配置', exact: true }))
    const field = await screen.findByRole('textbox', { name: '完整配置 JSON' })
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toContain('providers'))
    fireEvent.change(field, { target: { value: '{ invalid' } })
    expect((screen.getByRole('button', { name: '保存全部' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '取消修改' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '格式化草稿' }))
    expect((field as HTMLTextAreaElement).value).toContain('providers')
    expect(screen.getByText('所有修改已保存')).toBeTruthy()
    fireEvent.change(field, { target: { value: '{ invalid again' } })
    fireEvent.click(screen.getByRole('button', { name: '取消修改' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toContain('providers'))
    expect(fixture.writes).toEqual([])
  })

  it('does not keep loading after bootstrap fails and recovers through the Retry button', async () => {
    const fixture = sidebarFixture()
    let unavailable = true
    const transport = { ...fixture.transport, request: async (path: string, init?: RequestInit) => unavailable && path.startsWith('/api/session') ? new Response('{}', { status: 503 }) : fixture.transport.request(path, init) }
    render(<PulseDesignSystem><PulseApp transport={transport}/></PulseDesignSystem>)
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.queryByText('正在加载对话…')).toBeNull())
    unavailable = false
    fireEvent.click(screen.getByRole('button', { name: '重试', exact: true }))
    expect(await screen.findByText('聊点什么？')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes the mobile history drawer when resizing back to desktop', async () => {
    const original = window.matchMedia
    let change: (() => void) | undefined
    const mobile = { matches: true, addEventListener: (_: string, listener: () => void) => { change = listener }, removeEventListener() {} }
    vi.spyOn(window, 'matchMedia').mockImplementation(query => query === '(max-width: 767px)' ? mobile as unknown as MediaQueryList : original(query))
    const fixture = sidebarFixture()
    const view = render(<PulseDesignSystem><PulseApp transport={fixture.transport}/></PulseDesignSystem>)
    await screen.findByText('聊点什么？')
    fireEvent.click(screen.getByRole('tab', { name: '工作' }))
    await waitFor(() => expect(screen.queryByText('正在加载对话…')).toBeNull())
    fireEvent.click(await screen.findByRole('button', { name: '历史对话', exact: true }))
    await waitFor(() => expect(view.baseElement.querySelector('.ant-drawer-open')).toBeTruthy())
    act(() => { mobile.matches = false; change?.() })
    await waitFor(() => expect(view.baseElement.querySelector('.ant-drawer-open')).toBeNull())
    expect(screen.getByRole('tablist', { name: 'Pulse 工作模式' }).closest('.history-head')).toBeTruthy()
  })

  it('lets a clean settings page cancel an illegal program name without saving the mapping', async () => {
    const fixture = settingsFixture()
    const config = { ...fixture.config, execPolicy: { hostExecutables: { program1: ['/usr/bin/git'], program2: ['/bin/git'] } } }
    let saved: { config?: { execPolicy?: { hostExecutables?: Record<string, string[]> }; maxTurns?: number } } | undefined
    const transport = {
      subscribe: fixture.transport.subscribe,
      request: async (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (path === '/api/config' && method === 'GET') return new Response(JSON.stringify({ path: '/example/config.json', config, version: 'fixture', sources: {}, environment: {}, backupAvailable: false }), { headers: { 'Content-Type': 'application/json' } })
        if (path === '/api/config' && method === 'PUT') {
          saved = JSON.parse(String(init?.body))
          return new Response(JSON.stringify({ ok: true, path: '/example/config.json', version: 'fixture-2', applied: true, restartRequired: [], config: saved?.config }), { headers: { 'Content-Type': 'application/json' } })
        }
        return fixture.transport.request(path, init)
      },
    }
    render(<PulseDesignSystem><SettingsPage transport={transport} canEditConfig onClose={() => {}}/></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('button', { name: '审批与代审', exact: true }))
    fireEvent.click(await screen.findByText('受信程序路径'))
    const name = await screen.findByRole('textbox', { name: '路径映射 1 程序名' })
    expect((screen.getByRole('button', { name: '取消修改' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(name, { target: { value: 'program2' } })
    expect((name as HTMLInputElement).value).toBe('program2')
    expect((screen.getByRole('textbox', { name: '路径映射 2 受信路径' }) as HTMLTextAreaElement).value).toBe('/bin/git')
    expect(screen.getByText('有未保存的修改')).toBeTruthy()
    expect((screen.getByRole('button', { name: '取消修改' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '保存全部' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消修改' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '路径映射 1 程序名' }) as HTMLInputElement).value).toBe('program1'))
    expect(screen.getByText('所有修改已保存')).toBeTruthy()
    expect((screen.getByRole('button', { name: '保存全部' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: '路径映射 1 程序名' }), { target: { value: '' } })
    expect((screen.getByRole('button', { name: '取消修改' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '保存全部' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消修改' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '路径映射 1 程序名' }) as HTMLInputElement).value).toBe('program1'))
    fireEvent.click(screen.getByRole('button', { name: '运行与存储', exact: true }))
    const turns = await screen.findByRole('spinbutton', { name: /^最大执行轮数/ })
    fireEvent.change(turns, { target: { value: '40' } })
    fireEvent.blur(turns)
    expect((screen.getByRole('button', { name: '保存全部' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }))
    await waitFor(() => expect(saved?.config?.maxTurns).toBe(40))
    expect(saved?.config?.execPolicy?.hostExecutables).toEqual({ program1: ['/usr/bin/git'], program2: ['/bin/git'] })
  })
})

describe('question and approval pages', () => {
  it('validates selection, preserves answers between questions, and submits one complete batch', async () => {
    const submit = vi.fn().mockResolvedValue(true)
    const interaction = { kind: 'interaction' as const, runId: 'page-test', groupId: 'ask', interactionKind: 'ask' as const, items: [
      { effectId: 'choice', input: { type: 'choice', prompt: '选择模式', options: ['标准', '紧凑'] } },
      { effectId: 'multi', input: { type: 'multi', prompt: '选择页面', min: 1, max: 1, options: ['聊天', '设置'] } },
      { effectId: 'text', input: { type: 'input', prompt: '补充要求' } },
    ] }
    render(<PulseDesignSystem><InteractionPanel interaction={interaction} reviewNote="" delegated={false} submit={submit}/></PulseDesignSystem>)
    expect((screen.getByRole('button', { name: '下一题' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '标准', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '聊天' }))
    expect((screen.getByRole('checkbox', { name: '设置' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '检查所有页面' } })
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith([{ effectId: 'choice', value: { value: '标准' } }, { effectId: 'multi', value: { values: ['聊天'] } }, { effectId: 'text', value: { text: '检查所有页面' } }]))
    expect(localStorage.getItem('pulse-web-interaction:page-test:ask')).toBeNull()
  })
})
