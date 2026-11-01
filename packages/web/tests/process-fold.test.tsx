import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { processFoldFixture } from './fixtures/process-fold.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => window.localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function show(stopped: 'accepted' | 'budget' = 'accepted') {
  const f = processFoldFixture(stopped), router = createMemoryRouter([{ path: '*', element: <PulseApp transport={f.transport} /> }], { initialEntries: ['/work/pulse-chat'] })
  return { ...f, ...render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>) }
}

it('keeps separate round durations, summaries and products in order without exposing process prose', async () => {
  const f = show()
  await screen.findByRole('button', { name: /耗时 14 分 42 秒/ })
  await screen.findByRole('button', { name: /耗时 1 分 30 秒/ })
  expect(screen.getAllByText('已修复置顶状态保存，相关模拟测试通过。')).toHaveLength(1)
  expect(screen.getAllByText('已完成移动端检查，布局与交互符合要求。')).toHaveLength(1)
  expect(screen.queryByText('已找到状态保存入口，接下来检查回归用例。')).toBeNull()
  expect(screen.queryByText('正在检查移动端的布局与滚动行为。')).toBeNull()
  expect(await screen.findAllByRole('region', { name: '本轮交付文件' })).toHaveLength(2)
  const history = f.container.querySelector('.messages')!, text = history.textContent!
  expect(text.indexOf('耗时 14 分 42 秒')).toBeLessThan(text.indexOf('已修复置顶状态保存'))
  expect(text.indexOf('已修复置顶状态保存')).toBeLessThan(text.indexOf('reports/pinned-fix.md'))
  expect(text.indexOf('reports/pinned-fix.md')).toBeLessThan(text.indexOf('继续，检查移动端'))
  fireEvent.click(screen.getByRole('button', { name: /耗时 14 分 42 秒/ }))
  expect(screen.getAllByText('已找到状态保存入口，接下来检查回归用例。')).toHaveLength(1)
  expect(screen.queryByText('正在检查移动端的布局与滚动行为。')).toBeNull()
  expect(f.calls.filter(path => path.includes('budget-continuation') && path.includes('/runs/'))).toEqual([])
})

it('keeps budget failure and explicit renewal outside the collapsed process', async () => {
  const f = show('budget')
  const process = await screen.findByRole('button', { name: /执行过程.*TASK_MODEL_CALL_BUDGET_EXHAUSTED/ })
  expect(process.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByText('调用额度已用尽，当前任务尚未完成；已有改动与检查点已保留。')).toBeTruthy()
  expect(await screen.findByRole('button', { name: '继续，增加 256 次调用' })).toBeTruthy()
  expect(screen.queryByText('正在检查移动端的布局与滚动行为。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '暂不继续' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '继续，增加 256 次调用' })).toBeNull())
  expect(f.calls.filter(path => path.includes('/runs/') && path.includes('/budget-continuation'))).toEqual([])
})

it('keeps a terminal trace without tool or prose events inspectable', async () => {
  const f = processFoldFixture()
  f.traces[0]!.events = [f.traces[0]!.events.at(-1)!]
  const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={f.transport} /> }], { initialEntries: ['/work/pulse-chat'] })
  render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
  fireEvent.click(await screen.findByRole('button', { name: /耗时 14 分 42 秒/ }))
  expect(screen.getByText('暂无可用过程记录')).toBeTruthy()
})
