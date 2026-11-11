import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { MessageBubble } from '../src/MessageBubble.js'
import { ChatWorkPrompt } from '../src/ChatInteraction.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { ChatWorkAction, WebQuestionAnswer } from '@hunterzhu/pulse-server/protocol'

beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); localStorage.clear() })
const input = { type: 'choice', prompt: '选择部署方式？', context: '当前只有一台测试机。', options: [{ value: 'local', label: '本地预览（推荐）', description: '先验证交互流程。' }, { value: 'remote', label: '远程部署', description: '需要配置服务。' }] }
const bubble = (questionAnswer: WebQuestionAnswer, mode: 'chat' | 'work' = 'work') => <PulseDesignSystem><MessageBubble message={{ id: 'ask-answer-1', role: 'user', text: 'legacy answer text', createdAt: '2026-11-06T12:00:00Z', questionAnswer }} mode={mode} retry={() => {}} onOpenWork={() => {}}/></PulseDesignSystem>

it.each(['chat', 'work'] as const)('shows the original question and marked choice from a persisted %s message', mode => {
  const view = render(bubble({ effectId: 'q', input, answer: { value: 'remote' } }, mode))
  const card = view.getByRole('region', { name: '已回答问题' })
  expect(within(card).getByText(input.prompt)).toBeTruthy()
  expect(within(card).getByText(input.context)).toBeTruthy()
  expect(within(card).getByText('先验证交互流程。')).toBeTruthy()
  expect(within(card).getByText('远程部署').closest('li')?.classList.contains('selected')).toBe(true)
  expect(within(card).getByText('本地预览（推荐）').closest('li')?.classList.contains('selected')).toBe(false)
  expect(within(card).getAllByText('已选择')).toHaveLength(1)
  expect(within(card).queryByRole('button')).toBeNull()
  expect(view.queryByText('legacy answer text')).toBeNull()
})
it('retains every multi-select choice and distinguishes a valid empty selection', () => {
  const view = render(bubble({ effectId: 'q', input: { ...input, type: 'multi' }, answer: { values: ['local', 'remote'] } }))
  expect(view.getAllByText('已选择')).toHaveLength(2)
  view.rerender(bubble({ effectId: 'q', input: { ...input, type: 'multi' }, answer: { values: [] } }))
  expect(view.getByText('未选择任何选项')).toBeTruthy()
  expect(view.queryByText('已选择')).toBeNull()
})
it.each(['choice', 'multi', 'input'])('shows the accepted %s free text without marking an option', type => {
  const view = render(bubble({ effectId: 'q', input: { ...input, type }, answer: { text: '使用隔离环境验证。\n保留第二行。' } }))
  expect(view.getByText(type === 'input' ? '你的回答' : '自行回答')).toBeTruthy()
  expect(view.getByText(/使用隔离环境验证/).textContent).toBe('使用隔离环境验证。\n保留第二行。')
  expect(view.queryByText('已选择')).toBeNull()
})
it('keeps failed chat answers editable, then retains all cards after submission and reload', async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json({ error: 'retry' }, { status: 409 })).mockResolvedValue(Response.json({ ok: true }))
  const transport = { request, subscribe: () => () => {} }
  const action: ChatWorkAction = { callbackId: 'c', conversationId: 'work', runId: 'run', controlRevision: 0, fingerprint: 'f', interaction: { groupId: 'g', kind: 'ask', items: [{ effectId: 'q1', input }, { effectId: 'q2', input: { type: 'input', prompt: '补充说明' } }] } }
  const view = render(<PulseDesignSystem><ChatWorkPrompt action={action} transport={transport}/></PulseDesignSystem>)
  fireEvent.click(view.getByRole('button', { name: /本地预览/ }))
  fireEvent.click(view.getByRole('button', { name: '下一题' }))
  fireEvent.change(view.getByRole('textbox', { name: '你的答案' }), { target: { value: '保持现状' } })
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await view.findByRole('alert')
  expect((view.getByRole('textbox') as HTMLTextAreaElement).value).toBe('保持现状')
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(view.getAllByRole('region', { name: '已回答问题' })).toHaveLength(2))
  const answers = [{ effectId: 'q1', value: { value: 'local' } }, { effectId: 'q2', value: { text: '保持现状' } }]
  expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body)).answers).toEqual(answers)
  view.unmount()
  const restored = render(<PulseDesignSystem><ChatWorkPrompt action={{ ...action, state: 'answered', answers }} transport={transport}/></PulseDesignSystem>)
  expect(restored.getAllByRole('region', { name: '已回答问题' })).toHaveLength(2)
  expect(restored.getByText('保持现状')).toBeTruthy()
  expect(restored.queryByRole('button')).toBeNull()
  expect(request).toHaveBeenCalledTimes(2)
})
