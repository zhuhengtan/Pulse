import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { QualityReviewSelect } from '../src/QualityReviewSelect.js'
import { SettingsPage } from '../src/SettingsPage.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { messagePayload, retryMessagePayload } from '../src/message-payload.js'
import { settingsFixture } from './fixtures/settings.js'

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
})
afterEach(() => cleanup())

it('offers global, enabled and disabled task overrides and locks the choice while running', async () => {
  const change = vi.fn()
  const view = render(<PulseDesignSystem><QualityReviewSelect value={undefined} disabled={false} onChange={change} /></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('button', { name: '本次任务质量复核：跟随全局' }))
  fireEvent.click(await screen.findByText('本次跳过复核'))
  expect(change).toHaveBeenLastCalledWith(false)
  view.rerender(<PulseDesignSystem><QualityReviewSelect value={false} disabled onChange={change} /></PulseDesignSystem>)
  expect((screen.getByRole('button', { name: '本次任务质量复核：关闭' }) as HTMLButtonElement).disabled).toBe(true)
})

it('defaults quality review on and saves its setting without changing approval mode', async () => {
  const f = settingsFixture(), writes: any[] = []
  const transport = { ...f.transport, request: async (path: string, init?: RequestInit) => {
    if (path === '/api/config' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); writes.push(body)
      return Response.json({ ok: true, path: '/example/config.json', version: 'new', applied: true, restartRequired: [], config: body.config })
    }
    return f.transport.request(path, init)
  } }
  render(<PulseDesignSystem><SettingsPage transport={transport} canEditConfig category="approval" onCategoryChange={() => {}} onClose={() => {}} /></PulseDesignSystem>)
  const toggle = await screen.findByRole('switch', { name: '任务质量复核' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: '保存全部', exact: true }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0].config).toMatchObject({ qualityReviewEnabled: false, approvalMode: 'ask', approvalReview: f.config.approvalReview })
})

it('preserves an explicit false in queued snapshots and retries', async () => {
  const source = { text: 'implement', qualityReviewEnabled: false }
  const payload = messagePayload(source)
  source.qualityReviewEnabled = true
  expect(payload.qualityReviewEnabled).toBe(false)
  const message = { ...payload, id: 'm', role: 'user' as const, createdAt: 'now' }
  const transport = { request: vi.fn(async () => Response.json(message)), subscribe: () => () => {} }
  expect((await retryMessagePayload(transport, 'c', message)).qualityReviewEnabled).toBe(false)
  expect((await retryMessagePayload(transport, 'c', { ...message, bodyTruncated: true })).qualityReviewEnabled).toBe(false)
})
