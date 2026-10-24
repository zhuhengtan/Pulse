import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DeviceManagement } from '../src/DeviceManagement.js'
import { SettingsPage } from '../src/SettingsPage.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { settingsFixture } from './fixtures/settings.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const originalStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = element => originalStyle(element)
  Element.prototype.scrollTo = vi.fn()
})
afterEach(cleanup)
function fixture(options: { failRemove?: boolean; failList?: boolean; currentId?: string } = {}) {
  const devices = [{ id: 'current-local', name: 'This computer', clientType: 'electron', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-10-22T00:00:00Z' }, ...Array.from({ length: 10 }, (_, i) => ({ id: `phone-${String(i).padStart(8, '0')}`, name: `Phone ${i}`, clientType: i === 0 ? 'web' : 'h5', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: `2026-10-${String(21 - i).padStart(2, '0')}T00:00:00Z` }))]
  const writes: Array<{ path: string; body?: BodyInit | null }> = []
  const reads: string[] = []
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const transport: PulseWebTransport = {
    async request(path, init) {
      if (init?.method === 'POST') {
        writes.push({ path, ...(init.body === undefined ? {} : { body: init.body }) })
        if (options.failRemove && path.endsWith('/revoke')) return response({}, 500)
        return response({ ok: true })
      }
      reads.push(path)
      if (path === '/api/pair/qr') return response({ qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>', pairUrl: 'http://example.local/?code=fixture', expiresAt: Date.now() + 300000 })
      if (path === '/api/session') return response({ deviceId: options.currentId ?? 'current-local' })
      if (options.failList) return response({}, 500)
      return response(devices)
    },
    subscribe: () => () => {},
  }
  return { transport, writes, reads }
}
function mount(transport: PulseWebTransport, localAdmin = true) { return render(<PulseDesignSystem><DeviceManagement transport={transport} localAdmin={localAdmin} /></PulseDesignSystem>) }

describe('authorized device settings', () => {
  it('loads as an independent settings category without config editors or writes', async () => {
    const { transport, writes } = settingsFixture()
    render(<PulseDesignSystem><SettingsPage transport={transport} canEditConfig onClose={() => {}} category="devices" onCategoryChange={() => {}} /></PulseDesignSystem>)
    await screen.findByText('暂无已授权设备。')
    expect(screen.getByRole('heading', { name: '设备管理' })).toBeTruthy()
    expect(screen.queryByText('配置文件')).toBeNull()
    expect(screen.queryByRole('button', { name: '保存全部' })).toBeNull()
    expect(writes).toEqual([])
  })
  it('marks and protects the current client, paginates and searches duplicate-looking records', async () => {
    const { transport, writes } = fixture(); mount(transport)
    await screen.findByText('当前设备')
    expect(screen.getAllByRole('article')).toHaveLength(8)
    expect(within(screen.getByRole('article', { name: 'This computer nt-local' })).getByRole('button', { name: '移除' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getAllByText(/最近使用：/)).toHaveLength(8)
    fireEvent.click(screen.getByTitle('2'))
    expect(screen.getAllByRole('article')).toHaveLength(3)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索设备' }), { target: { value: '00000009' } })
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByText('Phone 9')).toBeTruthy()
    expect(writes).toEqual([])
  })
  it('cancels removal without a write, confirms removal and updates the list immediately', async () => {
    const { transport, writes } = fixture(); mount(transport)
    const device = await screen.findByRole('article', { name: 'Phone 0 00000000' })
    fireEvent.click(within(device).getByRole('button', { name: '移除' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes).toEqual([])
    fireEvent.click(within(device).getByRole('button', { name: '移除' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
    await screen.findByText('已移除设备授权。')
    expect(screen.queryByText('Phone 0')).toBeNull()
    expect(writes).toEqual([{ path: '/api/devices/phone-00000000/revoke' }])
  })
  it('distinguishes all client types and has no automation control switch', async () => {
    const { transport, writes } = fixture(); mount(transport)
    await screen.findByText('Electron')
    expect(screen.getByText('Web')).toBeTruthy()
    expect(screen.getAllByText('H5').length).toBeGreaterThan(0)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(writes).toEqual([])
  })
  it('opens H5 pairing from device settings and refreshes the expiring QR code', async () => {
    const { transport, writes, reads } = fixture(); mount(transport)
    await screen.findByText('当前设备')
    expect(reads).not.toContain('/api/pair/qr')
    fireEvent.click(screen.getByRole('button', { name: '扫码连接', exact: true }))
    await screen.findByRole('img', { name: 'H5 连接二维码' })
    expect(screen.getByRole('textbox', { name: 'H5 连接地址' }).getAttribute('value')).toBe('http://example.local/?code=fixture')
    fireEvent.click(await screen.findByRole('button', { name: '刷新二维码', exact: true }))
    await waitFor(() => expect(reads.filter(path => path === '/api/pair/qr')).toHaveLength(2))
    expect(writes).toEqual([])
  })
  it('preserves a record when removal fails and reports the failure', async () => {
    const { transport } = fixture({ failRemove: true }); mount(transport)
    fireEvent.click(within(await screen.findByRole('article', { name: 'Phone 0 00000000' })).getByRole('button', { name: '移除' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
    await screen.findByText('移除失败，请重试。')
    expect(screen.getByText('Phone 0')).toBeTruthy()
  })
  it('does not load devices on non-admin clients and reports loading failures', async () => {
    const denied = fixture(); const view = mount(denied.transport, false)
    expect(screen.getByText('请在运行 Pulse 的电脑上管理设备授权。')).toBeTruthy()
    expect(denied.reads).toEqual([])
    view.unmount()
    mount(fixture({ failList: true }).transport)
    await screen.findByRole('alert')
    expect(screen.queryByText('暂无已授权设备。')).toBeNull()
  })
})
