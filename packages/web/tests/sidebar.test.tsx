import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { sidebarFixture } from './fixtures/sidebar.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => window.localStorage.clear())
afterEach(cleanup)
async function show() {
  const fixture = sidebarFixture()
  const view = render(<PulseDesignSystem><PulseApp transport={fixture.transport}/></PulseDesignSystem>)
  await screen.findByText('我们要做什么？')
  fireEvent.click(screen.getByRole('tab', { name: '工作' }))
  await screen.findByRole('button', { name: '这个项目还是需要帮我加个自动审核' })
  return { ...view, ...fixture }
}
async function moveMenu(title: string) {
  fireEvent.click(screen.getByRole('button', { name: `对话操作：${title}` }))
  fireEvent.click(await screen.findByText('移动到项目', { selector: '.ant-dropdown-menu-title-content' }))
}

describe('project sidebar', () => {
  it('nests conversations once, keeps other projects visible, and preserves selection while folding', async () => {
    await show()
    const pulse = screen.getByRole('region', { name: 'Pulse项目对话' })
    expect(within(pulse).getByRole('button', { name: '优化侧边栏和主题 已置顶' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '优化侧边栏和主题 已置顶' })).toHaveLength(1)
    fireEvent.click(within(pulse).getByRole('button', { name: '优化侧边栏和主题 已置顶' }))
    await waitFor(() => expect(window.localStorage.getItem('pulse-web-conversation')).toBe('pulse-chat'))
    expect(screen.getByRole('button', { name: '完善项目记忆' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '折叠项目：Pulse' }))
    expect(screen.queryByRole('button', { name: '优化侧边栏和主题 已置顶' })).toBeNull()
    expect(window.localStorage.getItem('pulse-web-conversation')).toBe('pulse-chat')
    expect(JSON.parse(window.localStorage.getItem('pulse-web-collapsed-projects')!)).toContain('pulse')
    fireEvent.change(screen.getByRole('textbox', { name: '搜索对话' }), { target: { value: '优化侧边栏' } })
    expect(screen.getByRole('button', { name: '优化侧边栏和主题 已置顶' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索对话' }), { target: { value: '' } })
    expect(screen.getByRole('button', { name: '展开项目：Pulse' })).toBeTruthy()
  })

  it('moves legacy history directly into a project, expands it, and can move it back', async () => {
    const view = await show()
    fireEvent.click(screen.getByRole('button', { name: '折叠项目：Jarvis' }))
    await moveMenu('这个项目还是需要帮我加个自动审核')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Jarvis' }))
    await screen.findByText('对话已移动到Jarvis。')
    expect(view.patches).toEqual([{ id: 'old', body: { projectId: 'jarvis' } }])
    expect(within(screen.getByRole('region', { name: 'Jarvis项目对话' })).getByRole('button', { name: '这个项目还是需要帮我加个自动审核' })).toBeTruthy()
    expect(window.localStorage.getItem('pulse-web-project')).toBe('jarvis')
    await moveMenu('这个项目还是需要帮我加个自动审核')
    fireEvent.click(await screen.findByRole('menuitem', { name: '未分组' }))
    await screen.findByText('对话已移动到未分组。')
    expect(view.patches.at(-1)).toEqual({ id: 'old', body: { projectId: null } })
    expect(within(screen.getByRole('region', { name: '未分组对话' })).getByRole('button', { name: '这个项目还是需要帮我加个自动审核' })).toBeTruthy()
  })

  it('keeps history in place when the server rejects a move and disables moving busy conversations', async () => {
    const view = await show()
    view.rejectMove()
    await moveMenu('这个项目还是需要帮我加个自动审核')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pulse' }))
    await screen.findByText('对话仍有运行或待恢复任务，不能移动。')
    expect(within(screen.getByRole('region', { name: '未分组对话' })).getByRole('button', { name: '这个项目还是需要帮我加个自动审核' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '对话操作：正在执行的任务' }))
    expect((await screen.findByRole('menuitem', { name: /^移动到项目/ })).getAttribute('aria-disabled')).toBe('true')
  })

  it('starts new conversations in the requested project and restores fold state on remount', async () => {
    const view = await show()
    fireEvent.click(screen.getByRole('button', { name: '在Jarvis中新建对话' }))
    expect(window.localStorage.getItem('pulse-web-project')).toBe('jarvis')
    expect(screen.getByRole('combobox', { name: '新对话所属项目' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '折叠项目：Pulse' }))
    view.unmount()
    await show()
    expect(screen.getByRole('button', { name: '展开项目：Pulse' })).toBeTruthy()
  })
})
