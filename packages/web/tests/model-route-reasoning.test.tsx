import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { SettingsPage } from '../src/SettingsPage.js'
import { settingsFixture } from './fixtures/settings.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const style = window.getComputedStyle.bind(window)
  window.getComputedStyle = element => style(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(cleanup)
function show(enabled = true) {
  const fixture = settingsFixture(enabled)
  Object.assign(fixture.config.providers.sample.models.chat, { discovery: { supportedReasoningEfforts: ['none', 'low', 'xhigh', 'max'] } })
  render(<PulseDesignSystem><SettingsPage transport={fixture.transport} canEditConfig onClose={() => {}}/></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('button', { name: '模型路由', exact: true }))
  return fixture
}
async function choose(label: string, effort: string) {
  fireEvent.mouseDown(await screen.findByRole('combobox', { name: label }))
  fireEvent.click(await screen.findByText(effort, { selector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content' }))
}
it('keeps native depth attached to each model when a route is reordered', async () => {
  show()
  await choose('推理 首选 思考深度', '超高')
  await choose('规划 首选 思考深度', '最高')
  const reason = screen.getByRole('heading', { name: '推理', exact: true }).closest('section')!
  fireEvent.click(within(reason).getAllByRole('button', { name: '上移' })[1]!)
  fireEvent.click(screen.getByRole('button', { name: '高级配置', exact: true }))
  const draft = JSON.parse((await screen.findByLabelText('完整配置 JSON') as HTMLTextAreaElement).value)
  expect(draft.taskRouting.reason).toEqual(['local/review', { model: 'sample/chat', reasoningEffort: 'xhigh' }])
  expect(draft.taskRouting.plan).toEqual([{ model: 'sample/chat', reasoningEffort: 'max' }, 'local/review'])
})
it('disables known unsupported levels and preserves a legacy string when restored to default', async () => {
  show()
  const label = '推理 首选 思考深度'
  fireEvent.mouseDown(await screen.findByRole('combobox', { name: label }))
  expect((await screen.findByText('最低（不支持）', { selector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content' })).closest('.ant-select-item')?.className).toContain('option-disabled')
  fireEvent.click(await screen.findByText('关闭', { selector: '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content' }))
  await choose(label, '默认')
  fireEvent.click(screen.getByRole('button', { name: '高级配置', exact: true }))
  const draft = JSON.parse((await screen.findByLabelText('完整配置 JSON') as HTMLTextAreaElement).value)
  expect(draft.taskRouting.reason).toEqual(['sample/chat', 'local/review'])
})
it('keeps reasoning controls disabled when the backend does not advertise support', async () => {
  show(false)
  expect(await screen.findByText('升级后台后可为路由模型设置思考深度。')).toBeTruthy()
  expect((await screen.findByRole('combobox', { name: '推理 首选 思考深度' }) as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '高级配置', exact: true }))
  const editor = await screen.findByLabelText('完整配置 JSON') as HTMLTextAreaElement
  const config = JSON.parse(editor.value)
  config.taskRouting.reason = [{ model: 'sample/chat', reasoningEffort: 'xhigh' }]
  fireEvent.change(editor, { target: { value: JSON.stringify(config) } })
  fireEvent.click(screen.getByRole('button', { name: '保存全部' }))
  expect(await screen.findByText('升级后台后可保存包含思考深度的模型路由。')).toBeTruthy()
})
