// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PulseApp } from './RouterApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { sidebarFixture } from './fixtures/sidebar.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

async function show(fixture = sidebarFixture()) {
  const view = render(<PulseDesignSystem><PulseApp transport={fixture.transport}/></PulseDesignSystem>)
  await screen.findByText(/^(?:我们要做什么？|聊点什么？)$/)
  fireEvent.click(screen.getByRole('tab', { name: '工作' }))
  await screen.findByRole('button', { name: '这个项目还是需要帮我加个自动审核' })
  return { ...view, ...fixture }
}

const pinnedSection = () => screen.getByRole('button', { name: '置顶', exact: true }).closest('section') as HTMLElement

describe('conversation pinning', () => {
  it('renders only one pin icon and marks the pin action selected', async () => {
    await show()
    const button = within(pinnedSection()).getByRole('button', { name: '取消置顶对话：优化侧边栏和主题' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.querySelectorAll("svg")).toHaveLength(1)
    expect(pinnedSection().querySelector('.history-pin')).toBeNull()
  })

  it('folds the pin section independently of projects and remembers the choice after remount', async () => {
    const fixture=sidebarFixture(),view=await show(fixture)
    const button=screen.getByRole('button',{name:'置顶',exact:true})
    expect(button.classList.contains('project-nav-heading')).toBe(true)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button',{name:'优化侧边栏和主题 已置顶'})).toBeNull()
    expect(screen.getByRole('button',{name:'项目',exact:true}).getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('pulse-web-pinned-collapsed')).toBe('true')
    view.unmount();await show(fixture)
    expect(screen.getByRole('button',{name:'置顶',exact:true}).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button',{name:'置顶',exact:true}))
    expect(within(pinnedSection()).getByRole('button',{name:'优化侧边栏和主题 已置顶'})).toBeTruthy()
  })

  it('reveals matching pins during search without changing the saved collapsed choice', async () => {
    await show()
    fireEvent.click(screen.getByRole('button',{name:'置顶',exact:true}))
    fireEvent.change(screen.getByRole('textbox',{name:'搜索对话'}),{target:{value:'优化侧边栏'}})
    expect(screen.getByRole('button',{name:'置顶',exact:true}).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button',{name:'优化侧边栏和主题 已置顶'})).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox',{name:'搜索对话'}),{target:{value:''}})
    expect(screen.getByRole('button',{name:'置顶',exact:true}).getAttribute('aria-expanded')).toBe('false')
  })
  it('retains title, project and busy state when PATCH returns only the changed pin field', async () => {
    const fixture = sidebarFixture(), request = fixture.transport.request
    const stateCalls: string[] = [], deletions: string[] = []
    let runState: 'running' | 'unknown' = 'running'
    fixture.transport.request = async (path, init) => {
      if (path === '/api/runs/run-busy/state') {
        stateCalls.push(runState)
        return runState === 'running' ? Response.json({ runId: 'run-busy', state: 'running', seq: 0, activities: [] }) : Response.json({ error: 'unavailable' }, { status: 503 })
      }
      if (path === '/api/conversations/busy' && init?.method === 'DELETE') { deletions.push(path); return Response.json({ ok: true }) }
      const result = await request(path, init)
      return init?.method === 'PATCH' ? Response.json({ pinned: true }) : result
    }
    await show(fixture)
    fireEvent.click(screen.getByRole('button', { name: '置顶对话：正在执行的任务' }))
    const row = await within(pinnedSection()).findByRole('button', { name: '正在执行的任务 已置顶 运行状态待确认' })
    expect(row).toBeTruthy()
    expect(screen.getByRole('button', { name: '折叠项目：Jarvis' })).toBeTruthy()
    expect(fixture.patches).toEqual([{ id: 'busy', body: { pinned: true } }])
    const archive = screen.getByRole('button', { name: '归档对话：正在执行的任务', hidden: true })
    expect(archive.hasAttribute('disabled')).toBe(false)
    fireEvent.click(archive)
    expect(await screen.findByText('任务仍在运行或状态待确认，暂时不能归档。')).toBeTruthy()
    expect(stateCalls).toEqual(['running'])
    expect(fixture.patches).toEqual([{ id: 'busy', body: { pinned: true } }])
    expect(screen.getByRole('button', { name: '正在执行的任务 已置顶 运行状态待确认' })).toBeTruthy()
    runState = 'unknown'
    fireEvent.click(screen.getByRole('button', { name: '对话操作：正在执行的任务', hidden: true }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除', exact: true }))
    expect(await screen.findByText('任务仍在运行或状态待确认，暂时不能删除。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '确认', exact: true })).toBeNull()
    expect(stateCalls).toEqual(['running', 'unknown'])
    expect(deletions).toEqual([])
    expect(fixture.patches).toEqual([{ id: 'busy', body: { pinned: true } }])
  })

  it('shows the optimistic pin and sends only one request while it is pending', async () => {
    const fixture=sidebarFixture(), request=fixture.transport.request
    let release!:()=>void
    const gate=new Promise<void>(done=>{release=done})
    fixture.transport.request=async(path,init)=>{if(init?.method==='PATCH')await gate;return request(path,init)}
    await show(fixture)
    fireEvent.click(screen.getByRole('button',{name:'置顶对话：这个项目还是需要帮我加个自动审核'}))
    expect(within(pinnedSection()).getByRole('button',{name:'这个项目还是需要帮我加个自动审核 已置顶'})).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'取消置顶对话：这个项目还是需要帮我加个自动审核'}))
    release()
    await waitFor(()=>expect(fixture.patches).toEqual([{id:'old',body:{pinned:true}}]))
  })

  it('restores persisted pins after remounting without duplicating their project row', async () => {
    const fixture=sidebarFixture(), view=await show(fixture)
    fireEvent.click(screen.getByRole('button',{name:'置顶对话：完善项目记忆'}))
    await waitFor(()=>expect(fixture.patches).toHaveLength(1))
    view.unmount()
    await show(fixture)
    expect(within(pinnedSection()).getByRole('button',{name:'完善项目记忆 已置顶'})).toBeTruthy()
    expect(within(screen.getByRole('region',{name:'Jarvis项目对话'})).queryByRole('button',{name:'完善项目记忆 已置顶'})).toBeNull()
    expect(screen.getAllByRole('button',{name:'完善项目记忆 已置顶'})).toHaveLength(1)
  })
  it('marks a conversation as pinned, moves it into the pinned group first, and records the PATCH body', async () => {
    const view = await show()
    expect(screen.queryByRole('button', { name: '置顶', exact: true })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '置顶对话：这个项目还是需要帮我加个自动审核' }))

    await waitFor(() => expect(view.patches).toEqual([{ id: 'old', body: { pinned: true } }]))
    await screen.findByRole('button', { name: '这个项目还是需要帮我加个自动审核 已置顶' })

    const group = pinnedSection()
    expect(within(group).getByRole('button', { name: '这个项目还是需要帮我加个自动审核 已置顶' })).toBeTruthy()
    expect(within(group).getByRole('button', { name: '优化侧边栏和主题 已置顶' })).toBeTruthy()
    // 新置顶的会话排进置顶分组首位，位于原有置顶项之前
    const pinnedRows = [...group.querySelectorAll('.history-item')].map(node => node.textContent?.trim() ?? '')
    expect(pinnedRows).toHaveLength(2)
    expect(pinnedRows[0]).toContain('这个项目还是需要帮我加个自动审核')

    // 置顶后该会话离开原列表，只以“已置顶”条目渲染一次；置顶分组整体排在项目分组之前
    expect(screen.queryByRole('button', { name: '这个项目还是需要帮我加个自动审核' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '这个项目还是需要帮我加个自动审核 已置顶' })).toHaveLength(1)
    const project = screen.getByRole('region', { name: 'Pulse项目对话' })
    expect(group.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('unpins a pinned conversation back to its project group and records the PATCH body', async () => {
    const view = await show()
    expect(within(pinnedSection()).getByRole('button', { name: '优化侧边栏和主题 已置顶' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '取消置顶对话：优化侧边栏和主题' }))

    await waitFor(() => expect(view.patches).toEqual([{ id: 'pulse-chat', body: { pinned: false } }]))
    const pulse = screen.getByRole('region', { name: 'Pulse项目对话' })
    await within(pulse).findByRole('button', { name: '优化侧边栏和主题' })
    expect(screen.queryByRole('button', { name: '置顶', exact: true })).toBeNull()
    expect(screen.queryByRole('button', { name: '优化侧边栏和主题 已置顶' })).toBeNull()
  })

  it('rolls the pin state back when the server rejects the update', async () => {
    const view = await show()
    view.rejectMove()

    fireEvent.click(screen.getByRole('button', { name: '置顶对话：这个项目还是需要帮我加个自动审核' }))

    await waitFor(() => expect(view.patches).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '这个项目还是需要帮我加个自动审核' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: '这个项目还是需要帮我加个自动审核 已置顶' })).toBeNull()
    expect(within(pinnedSection()).getByRole('button', { name: '优化侧边栏和主题 已置顶' })).toBeTruthy()
  })
})
