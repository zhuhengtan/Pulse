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

  it('shows a failed image probe in an Ant Design dialog without saving the draft', async () => {
    const fixture = settingsFixture()
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<PulseDesignSystem><SettingsPage transport={fixture.transport} canEditConfig onClose={() => {}}/></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('button', { name: '模型与服务商', exact: true }))
    fireEvent.click((await screen.findAllByRole('button', { name: '检测已保存模型的图像输入', exact: true }))[0]!)
    expect(await screen.findByRole('dialog')).toBeTruthy()
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
    expect(await screen.findByText('我们要做什么？')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes the mobile history drawer when resizing back to desktop', async () => {
    const original = window.matchMedia
    let change: (() => void) | undefined
    const mobile = { matches: true, addEventListener: (_: string, listener: () => void) => { change = listener }, removeEventListener() {} }
    vi.spyOn(window, 'matchMedia').mockImplementation(query => query === '(max-width: 767px)' ? mobile as unknown as MediaQueryList : original(query))
    const fixture = sidebarFixture()
    const view = render(<PulseDesignSystem><PulseApp transport={fixture.transport}/></PulseDesignSystem>)
    await screen.findByText('我们要做什么？')
    fireEvent.click(screen.getByRole('tab', { name: '工作' }))
    await waitFor(() => expect(screen.queryByText('正在加载对话…')).toBeNull())
    fireEvent.click(await screen.findByRole('button', { name: '历史对话', exact: true }))
    await waitFor(() => expect(view.baseElement.querySelector('.ant-drawer-open')).toBeTruthy())
    act(() => { mobile.matches = false; change?.() })
    await waitFor(() => expect(view.baseElement.querySelector('.ant-drawer-open')).toBeNull())
    expect(screen.getByRole('tablist', { name: 'Pulse 工作模式' }).closest('.history-head')).toBeTruthy()
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
    render(<PulseDesignSystem><InteractionPanel interaction={interaction} reviewNote="" delegated={false} running stopping={false} stop={() => {}} submit={submit} setApprovalPolicy={async () => true}/></PulseDesignSystem>)
    expect((screen.getByRole('button', { name: '下一题' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '标准', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '聊天' }))
    expect((screen.getByRole('checkbox', { name: '设置' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '下一题' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '检查所有页面' } })
    fireEvent.click(screen.getByRole('button', { name: '检查答案' }))
    expect(screen.getByText('检查所有页面')).toBeTruthy()
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '统一提交' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith([{ effectId: 'choice', value: { value: '标准' } }, { effectId: 'multi', value: { values: ['聊天'] } }, { effectId: 'text', value: { text: '检查所有页面' } }]))
    expect(localStorage.getItem('pulse-web-interaction:page-test:ask')).toBeNull()
  })
})
