import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ComponentVersions } from '../src/ComponentVersions.js'
import { SettingsPage } from '../src/SettingsPage.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  HTMLElement.prototype.scrollTo = vi.fn()
})
afterEach(() => { cleanup(); document.querySelector('meta[name="pulse-frontend-version"]')?.remove() })
function fixture() {
  const calls: string[] = []
  const status = {
    frontend: 'frontend-0.8.1', frontendVersion: '0.8.1', running: { backend: '0.8.0', shell: '0.7.0' },
    modules: [{ name: '@hunterzhu/pulse-server', title: 'Server', version: '0.8.0' }, { name: '@hunterzhu/pulse-data', title: 'Data', version: '0.7.9' }],
    staged: { frontend: { version: '0.8.2' } }, previous: { backend: { version: '0.7.0' } },
    available: [{ component: 'frontend', version: '0.9.0', requires: { backend: '0.9.0', shell: '0.8.0' } }],
  }
  const transport: PulseWebTransport = {
    subscribe: () => () => {}, request: vi.fn(async (path) => {
      calls.push(path)
      if (path === '/api/config') return Response.json({ path: '/config.json', version: 'config', config: {}, sources: {}, environment: {}, backupAvailable: false })
      if (path === '/api/updates/check') return Response.json({ ...status, checkedAt: '2026-10-25T12:00:00Z' }, { status: 202 })
      if (path === '/api/updates') return Response.json(status)
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
    }),
  }
  return { transport, calls }
}
describe('Pulse component versions', () => {
  it('has a dedicated settings page with independent module versions, staged versions and update navigation', async () => {
    const { transport, calls } = fixture(), navigate = vi.fn()
    render(<PulseDesignSystem><SettingsPage transport={transport} canEditConfig category="versions" onCategoryChange={navigate} onClose={() => {}}/></PulseDesignSystem>)
    const frontend = await screen.findByRole('article', { name: 'Web / H5 界面' })
    expect(await within(frontend).findByText('0.8.1')).toBeTruthy()
    expect(within(frontend).getByText('0.9.0')).toBeTruthy()
    expect(within(frontend).getByText('0.8.2')).toBeTruthy()
    expect(within(frontend).getByText(/后台 ≥ 0.9.0/)).toBeTruthy()
    expect(screen.getByText('0.7.9')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存全部' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '检查 Pulse 更新' }))
    await screen.findByText(/发布信息检查时间/)
    fireEvent.click(screen.getByRole('button', { name: '前往软件更新' }))
    expect(navigate).toHaveBeenCalledWith('updates')
    expect(calls.some(path => path.startsWith('/api/skill-marketplace'))).toBe(false)
  })
  it('distinguishes the open page version from the selected frontend', async () => {
    const meta = document.createElement('meta'); meta.name = 'pulse-frontend-version'; meta.content = '0.8.0'; document.head.append(meta)
    render(<PulseDesignSystem><ComponentVersions transport={fixture().transport} canManage onOpenUpdates={() => {}}/></PulseDesignSystem>)
    await screen.findByText('0.8.0（刷新后使用当前版本）')
  })
  it('does not expose module inventory or update mutations to a paired device', async () => {
    render(<PulseDesignSystem><ComponentVersions transport={fixture().transport} canManage={false} onOpenUpdates={() => {}}/></PulseDesignSystem>)
    await screen.findByText('完整组件版本和更新由本机管理员查看。')
    expect(screen.queryByText('@hunterzhu/pulse-data')).toBeNull()
    expect(screen.queryByRole('button', { name: '检查 Pulse 更新' })).toBeNull()
  })
})
