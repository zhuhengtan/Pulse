import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { SettingsPage, jarvisRecordsImportantChanges, jarvisWithRecording } from '../src/SettingsPage.js'
import { settingsFixture } from './fixtures/settings.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => cleanup())

function page(jarvis: Record<string, unknown>) {
  const base = settingsFixture()
  const config = { ...base.config, jarvis: { ...base.config.jarvis, ...jarvis } }
  const puts: Array<{ config: { jarvis: Record<string, unknown> } }> = []
  const transport: PulseWebTransport = {
    async request(path, init) {
      const method = init?.method ?? 'GET'
      if (path === '/api/config' && method === 'GET') return Response.json({ path: '/example/config.json', config, version: 'fixture', sources: {}, environment: {}, backupAvailable: false, active: { provider: 'sample', model: 'sample/chat' } })
      if (path === '/api/config/validate') return Response.json({ valid: true, restartRequired: [] })
      if (path === '/api/config' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { config: { jarvis: Record<string, unknown> } }
        puts.push(body)
        return Response.json({ ok: true, path: '/example/config.json', version: 'fixture-2', applied: true, restartRequired: [], config: body.config })
      }
      return base.transport.request(path, init)
    },
    subscribe: () => () => {},
  }
  render(<PulseDesignSystem><SettingsPage transport={transport} canEditConfig onClose={() => {}} /></PulseDesignSystem>)
  return { puts }
}

describe('Jarvis recording switch', () => {
  it('shows an existing explicit policy as off and saves both fields together', async () => {
    expect(jarvisRecordsImportantChanges({ observationPolicy: 'explicit', autoCandidate: true })).toBe(false)
    expect(jarvisRecordsImportantChanges({ autoCandidate: false })).toBe(false)
    expect(jarvisRecordsImportantChanges({ autoCandidate: true })).toBe(true)
    expect(jarvisWithRecording({ enabled: true }, true)).toMatchObject({ observationPolicy: 'important', autoCandidate: true })
    const { puts } = page({ observationPolicy: 'explicit', autoCandidate: true })
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis', exact: true }))
    const recording = await screen.findByRole('switch', { name: /^记录重要变化/ })
    expect(recording.getAttribute('aria-checked')).toBe('false')
    expect(document.body.textContent).toContain('不会为每个任务强制开关记忆会话')
    fireEvent.click(recording)
    expect(recording.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]!.config.jarvis).toMatchObject({ observationPolicy: 'important', autoCandidate: true, enabled: true })
  })

  it('describes legacy protocol as candidate capture rather than personal on-demand memory', async () => {
    expect(jarvisRecordsImportantChanges({ protocol: 'legacy', observationPolicy: 'explicit', autoCandidate: true })).toBe(true)
    page({ protocol: 'legacy', observationPolicy: 'explicit', autoCandidate: true })
    fireEvent.click(screen.getByRole('button', { name: 'Jarvis', exact: true }))
    const recording = await screen.findByRole('switch', { name: /^记录重要变化/ })
    expect(recording.getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain('任务准备阶段会查询并筛选相关记忆')
    expect(document.body.textContent).toContain('任务结束时自动整理候选记忆')
    expect(document.body.textContent).not.toContain('不会为每个任务强制开关记忆会话')
    fireEvent.click(recording)
    expect(jarvisWithRecording({ protocol: 'legacy', autoCandidate: true }, false)).toMatchObject({ observationPolicy: 'explicit', autoCandidate: false })
  })
})
