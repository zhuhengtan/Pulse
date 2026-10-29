import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { SettingsPage } from '../src/SettingsPage.js'
import { UpdateSettings } from '../src/Updates.js'
import { parsePulseRoute } from '../src/routing.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  HTMLElement.prototype.scrollTo = vi.fn()
})
afterEach(() => cleanup())

function fixture() {
  const status = {
    frontend: 'frontend-0.8.1',
    frontendVersion: '0.8.1',
    running: { backend: '0.8.0', shell: '0.7.0' },
    modules: [
      { name: '@hunterzhu/pulse-server', title: 'Server', version: '0.8.0' },
      { name: '@hunterzhu/pulse-data', title: 'Data', version: '0.7.9' },
    ],
    staged: { frontend: { version: '0.8.2' } },
    previous: { backend: { version: '0.7.0' } },
    available: [{ component: 'frontend', version: '0.9.0', requires: { backend: '0.9.0', shell: '0.8.0' } }],
    environment: { node: '22.1.0', chromium: 130 },
    checkedAt: '2026-10-25T12:00:00Z',
  }
  const transport: PulseWebTransport = {
    subscribe: () => () => {},
    request: vi.fn(async (path: string) => {
      if (path === '/api/config') return Response.json({ path: '/config.json', version: 'config', config: {}, sources: {}, environment: {}, backupAvailable: false })
      if (path === '/api/updates') return Response.json(status)
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
    }),
  }
  return transport
}

describe('merged software update settings page', () => {
  it('shows component versions, backend modules and environment in one software update page', async () => {
    render(<PulseDesignSystem><SettingsPage transport={fixture()} canEditConfig category="updates" onCategoryChange={vi.fn()} onClose={() => {}}/></PulseDesignSystem>)
    expect(await screen.findByText('软件更新与组件版本')).toBeTruthy()
    expect(screen.getAllByText('软件更新与组件版本')).toHaveLength(1)
    const frontend = await screen.findByRole('article', { name: 'Web / H5 界面' })
    expect(within(frontend).getByText('0.8.1')).toBeTruthy()
    expect(within(frontend).getByText('0.9.0')).toBeTruthy()
    expect(within(frontend).getByText('0.8.2')).toBeTruthy()
    expect(within(frontend).getByText(/后台 ≥ 0.9.0/)).toBeTruthy()
    expect(screen.getByRole('article', { name: 'Electron 桌面壳' })).toBeTruthy()
    expect(screen.getByRole('article', { name: '后台运行包' })).toBeTruthy()
    expect(screen.getByText('后台内部模块')).toBeTruthy()
    expect(screen.getByText('@hunterzhu/pulse-data')).toBeTruthy()
    expect(screen.getByText('Node.js 22.1.0 · Chromium 130')).toBeTruthy()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '检查 Pulse 更新' })).toBeNull()
    expect(screen.queryByRole('button', { name: '前往软件更新' })).toBeNull()
  })

  it('keeps a single settings entry for updates', async () => {
    render(<PulseDesignSystem><SettingsPage transport={fixture()} canEditConfig category="updates" onCategoryChange={vi.fn()} onClose={() => {}}/></PulseDesignSystem>)
    const nav = await screen.findByRole('navigation', { name: '设置分类' })
    expect(within(nav).getByText('软件更新')).toBeTruthy()
    expect(within(nav).queryByText('组件版本')).toBeNull()
  })

  it('routes the legacy component versions address to the merged page', async () => {
    const legacy = parsePulseRoute('/settings/versions')
    expect(legacy.page).toBe('settings')
    expect(legacy.category).toBe('updates')
    expect(parsePulseRoute('/settings/updates').category).toBe('updates')
    render(<PulseDesignSystem><SettingsPage transport={fixture()} canEditConfig category={legacy.category} onCategoryChange={vi.fn()} onClose={() => {}}/></PulseDesignSystem>)
    expect(await screen.findByText('软件更新与组件版本')).toBeTruthy()
    expect(await screen.findByRole('article', { name: 'Web / H5 界面' })).toBeTruthy()
  })

  it('hides the component inventory and update mutations from a paired device', async () => {
    render(<PulseDesignSystem><UpdateSettings transport={fixture()} canManage={false} /></PulseDesignSystem>)
    await screen.findByText('完整组件版本和更新由本机管理员查看。')
    expect(screen.queryByText('@hunterzhu/pulse-data')).toBeNull()
    expect(screen.queryByText('后台内部模块')).toBeNull()
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull()
  })
})
