vi.mock('../src/SceneSandbox.js', () => ({ SceneSandbox: () => null }))
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceUseSettings } from '../src/DeviceUseSettings.js'
import { parsePulseRoute } from '../src/routing.js'
import type { PulseWebTransport } from '../src/transport.js'
// The independently tested diagnostic child owns a separate read-only request.
vi.mock('../src/TerminalDiagnostics.js', () => ({ TerminalDiagnostics: () => null }))
const confirm = vi.fn(async () => true), prompt = vi.fn()
vi.mock('../src/PulseControls.js', () => ({ usePulseDialogs: () => ({ confirm, prompt }) }))
const disabled = { enabled: false, ready: false, mode: 'simulator', devices: [], grants: [], commands: [] }
const lamp = { deviceId: 'sim:light', adapter: 'simulator', name: '模拟客厅灯', roomId: 'living-room', aliases: [], enrolled: true, stale: true, availability: 'offline', observedAt: 1, state: { power: false }, capabilities: [{ kind: 'power', writable: true }, { kind: 'brightness', writable: true }] }
function transport(status = disabled) {
  const request = vi.fn(async (_path: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { ...status, enabled: true, ready: true } : status), { headers: { 'content-type': 'application/json' } }))
  return { value: { request, subscribe: () => () => {} } as PulseWebTransport, request }
}
beforeEach(() => { globalThis.ResizeObserver = class { observe() {}; unobserve() {}; disconnect() {} }; Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true }); confirm.mockReset(); confirm.mockResolvedValue(true); prompt.mockReset() })
afterEach(() => cleanup())
describe('Device Use settings', () => {
  it('routes to the distinct hardware settings rather than client-device pairing', () => {
    expect(parsePulseRoute('/settings/device-use')).toMatchObject({ page: 'settings', category: 'device-use' })
    expect(parsePulseRoute('/settings/devices')).toMatchObject({ page: 'settings', category: 'devices' })
  })
  it('does not request settings or expose credential/grant controls to a paired session', () => {
    const t = transport(); render(<DeviceUseSettings transport={t.value} canManage={false} />)
    expect(t.request).not.toHaveBeenCalled(); expect(screen.queryByLabelText('HA 本次令牌')).toBeNull()
    expect(screen.getByText(/只能在本机管理会话/)).toBeTruthy()
  })
  it('states disabled/simulator/real hardware limits and requires an explicit enable action', async () => {
    const t = transport(); render(<DeviceUseSettings transport={t.value} canManage />)
    await screen.findByText('已关闭'); expect(t.request).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/尚未发现设备/)).toBeTruthy(); expect(screen.getByText(/不支持开锁/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '启用模拟器' }))
    await waitFor(() => expect(t.request).toHaveBeenCalledTimes(2))
    expect(JSON.parse(String(t.request.mock.calls[1]?.[1]?.body))).toEqual({ enabled: true, mode: 'simulator' })
    await screen.findByText('仅模拟器，无真实硬件')
  })
  it('marks stale/offline observations and uncertain command outcomes without false success', async () => {
    const t = transport({ ...disabled, enabled: true, ready: true, devices: [lamp], commands: [{ commandId: 'command-1', request: { deviceId: 'sim:light' }, status: 'unknown', updatedAt: 2 }] } as any)
    render(<DeviceUseSettings transport={t.value} canManage />)
    await screen.findByText(/过时或离线，不是实时读数/)
    expect(screen.getByText(/结果不明，请先对账/)).toBeTruthy(); expect(screen.getByText(/已发送不等于已完成/)).toBeTruthy()
  })
  it('canceling credential handoff never posts or clears into an external destination', async () => {
    const t = transport(); confirm.mockResolvedValue(false); render(<DeviceUseSettings transport={t.value} canManage />)
    await screen.findByText('已关闭')
    fireEvent.change(screen.getByLabelText('HA 网关地址'), { target: { value: 'https://test.example' } })
    fireEvent.change(screen.getByLabelText('HA 本次令牌'), { target: { value: 'fixture-secret' } })
    fireEvent.change(screen.getByLabelText('HA 实体白名单'), { target: { value: 'light.test' } })
    fireEvent.click(screen.getByRole('button', { name: '交接令牌并连接白名单' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(t.request).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText('HA 本次令牌') as HTMLInputElement).type).toBe('password')
  })
  it('clears token immediately on explicit handoff and shows sanitized failure without automatic retry', async () => {
    const t = transport(); t.request.mockImplementation(async (_path, init) => { if (init?.method === 'POST') throw new Error('secret must never appear'); return new Response(JSON.stringify(disabled)) })
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    fireEvent.change(screen.getByLabelText('HA 网关地址'), { target: { value: 'https://test.example' } })
    fireEvent.change(screen.getByLabelText('HA 本次令牌'), { target: { value: 'fixture-secret' } })
    fireEvent.change(screen.getByLabelText('HA 实体白名单'), { target: { value: 'light.test sensor.temperature' } })
    fireEvent.click(screen.getByRole('button', { name: '交接令牌并连接白名单' }))
    await screen.findByRole('alert'); expect((screen.getByLabelText('HA 本次令牌') as HTMLInputElement).value).toBe('')
    expect(screen.queryByText(/secret must never appear/)).toBeNull(); expect(t.request).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(t.request.mock.calls[1]?.[1]?.body))).toMatchObject({ entities: [{ entityId: 'light.test', writable: false }, { entityId: 'sensor.temperature', writable: false }] })
  })
  it('canceling disable keeps current grants and does not post', async () => {
    const t = transport({ ...disabled, enabled: true, ready: true } as any); confirm.mockResolvedValue(false)
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('仅模拟器，无真实硬件')
    fireEvent.click(screen.getByRole('button', { name: '关闭并撤权' })); await waitFor(() => expect(confirm).toHaveBeenCalledOnce()); expect(t.request).toHaveBeenCalledTimes(1)
  })
  it('shows retained pending evidence and frozen grant/revoke audit while disabled', async () => {
    const t = transport({ ...disabled, unresolvedCount: 1, terminalHistoryTruncated: true, permissionEventCount: 2,
      permissionEvents: [{ eventId: 'revoke-1', at: 2000, action: 'revoke', grant: { deviceId: 'sim:light', actions: ['power'] } }],
      commands: [{ commandId: 'pending-old', request: { deviceId: 'sim:light' }, status: 'unknown', updatedAt: 1000, audit: { origin: { entryPoint: 'host-executor' }, dispatch: { grant: { actions: ['power', 'brightness'], expiresAt: 3000, limits: { brightness: { max: 40 } } }, confirmation: { required: true, verifiedByHost: true } } } }],
    } as any)
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    expect(screen.getByText(/保留的未决命令：1/)).toBeTruthy()
    expect(screen.getByText(/所有未决命令都保留展示/)).toBeTruthy()
    expect(screen.getByText(/亮度上限 40%/)).toBeTruthy()
    expect(screen.getByText(/可信 Host 已验证/)).toBeTruthy()
    expect(screen.getByText(/撤销授权 · sim:light/)).toBeTruthy()
    expect(t.request).toHaveBeenCalledTimes(1)
  })
  it('explains audit-capacity refusal without offering to erase unresolved evidence', async () => {
    const t = transport(); t.request.mockImplementation(async (_path, init) => new Response(JSON.stringify(init?.method === 'POST' ? { error: 'DEVICE_PERMISSION_AUDIT_CAPACITY' } : disabled), { status: init?.method === 'POST' ? 400 : 200 }))
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    fireEvent.click(screen.getByRole('button', { name: '启用模拟器' }))
    const error = await screen.findByRole('alert')
    expect(error.textContent).toContain('现有授权仍可立即撤销')
    expect(error.textContent).toContain('不要删除命令或未决记录')
    expect(t.request).toHaveBeenCalledTimes(2)
  })

  it('restores the saved gateway-scoped unit but resets it on gateway or home edits, never on refresh', async () => {
    const t = transport({ ...disabled, homeAssistantTemperature: { baseUrl: 'https://saved.example', homeId: 'saved-home', climateTemperatureUnit: 'fahrenheit' } } as any)
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    expect((screen.getByLabelText('HA 网关地址') as HTMLInputElement).value).toBe('https://saved.example')
    expect((screen.getByLabelText('家庭标识') as HTMLInputElement).value).toBe('saved-home')
    expect((screen.getByLabelText('空调只读温标') as HTMLSelectElement).value).toBe('fahrenheit')
    fireEvent.change(screen.getByLabelText('HA 网关地址'), { target: { value: 'https://new.example' } })
    expect((screen.getByLabelText('空调只读温标') as HTMLSelectElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('空调只读温标'), { target: { value: 'celsius' } })
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' })); await waitFor(() => expect(t.request).toHaveBeenCalledTimes(2))
    expect((screen.getByLabelText('HA 网关地址') as HTMLInputElement).value).toBe('https://new.example')
    expect((screen.getByLabelText('空调只读温标') as HTMLSelectElement).value).toBe('celsius')
    fireEvent.change(screen.getByLabelText('家庭标识'), { target: { value: 'new-home' } })
    expect((screen.getByLabelText('空调只读温标') as HTMLSelectElement).value).toBe('')
  })
  it.each(['', 'celsius', 'fahrenheit'])('hands off only explicitly selected unit %s and keeps climate read-only in confirmation', async unit => {
    const t = transport(); render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    fireEvent.change(screen.getByLabelText('HA 网关地址'), { target: { value: 'https://test.example' } })
    fireEvent.change(screen.getByLabelText('HA 本次令牌'), { target: { value: 'fixture-secret' } })
    fireEvent.change(screen.getByLabelText('HA 实体白名单'), { target: { value: 'climate.ac' } })
    fireEvent.change(screen.getByLabelText('空调只读温标'), { target: { value: unit } })
    fireEvent.click(screen.getByRole('button', { name: '交接令牌并连接白名单' }))
    await waitFor(() => expect(t.request).toHaveBeenCalledTimes(2))
    const body = JSON.parse(String(t.request.mock.calls[1]?.[1]?.body))
    expect(body.entities).toEqual([{ entityId: 'climate.ac', writable: false }])
    if (unit) expect(body.climateTemperatureUnit).toBe(unit); else expect(body).not.toHaveProperty('climateTemperatureUnit')
    expect(confirm.mock.calls[0]?.[0]).toContain('空调始终只读')
    expect(confirm.mock.calls[0]?.[0]).toContain(unit === 'celsius' ? '摄氏 °C' : unit === 'fahrenheit' ? '华氏 °F' : '温度将隐藏')
    expect((screen.getByLabelText('HA 本次令牌') as HTMLInputElement).value).toBe('')
  })

  it('does not replace a user-edited unit or gateway when the initial status arrives late', async () => {
    const t = transport(); let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    t.request.mockImplementation(async () => { await gate; return new Response(JSON.stringify({ ...disabled, homeAssistantTemperature: { baseUrl: 'https://saved.example', homeId: 'saved-home', climateTemperatureUnit: 'fahrenheit' } })) })
    render(<DeviceUseSettings transport={t.value} canManage />)
    fireEvent.change(screen.getByLabelText('HA 网关地址'), { target: { value: 'https://edited.example' } })
    fireEvent.change(screen.getByLabelText('空调只读温标'), { target: { value: 'celsius' } })
    release(); await screen.findByText('已关闭')
    expect((screen.getByLabelText('HA 网关地址') as HTMLInputElement).value).toBe('https://edited.example')
    expect((screen.getByLabelText('家庭标识') as HTMLInputElement).value).toBe('home')
    expect((screen.getByLabelText('空调只读温标') as HTMLSelectElement).value).toBe('celsius')
  })

  it.each(['offline', 'credentials-required', 'state-mismatch', 'connection-unverified', 'disabled', 'read-timeout', 'state-match-unverified'])('shows explicit %s query feedback while preserving unknown and only posting the original ID', async outcome => {
    const command = { commandId: 'pending-original', request: { deviceId: 'sim:light' }, status: 'unknown', updatedAt: 1 }
    const pending = { ...disabled, commands: [command], unresolvedCount: 1 }
    const t = transport(pending as any)
    t.request.mockImplementation(async (_path, init) => new Response(JSON.stringify(init?.method === 'POST' ? { ...pending, reconciliation: { commandId: command.commandId, outcome, checkedAt: 2000 } } : pending)))
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    fireEvent.click(screen.getByRole('button', { name: '只读查询原命令状态' }))
    await waitFor(() => expect(t.request).toHaveBeenCalledTimes(2))
    expect(t.request.mock.calls[1]?.[0]).toBe('/api/device-use/reconcile')
    expect(JSON.parse(String(t.request.mock.calls[1]?.[1]?.body))).toEqual({ commandId: 'pending-original' })
    const feedback = await screen.findByRole('status')
    expect(feedback.textContent).toContain(outcome === 'offline' ? '设备离线' : outcome === 'credentials-required' ? '缺少本机凭据' : outcome === 'state-mismatch' ? '当前状态与原目标不一致' : outcome === 'connection-unverified' ? '无法核验当前网关' : outcome === 'disabled' ? '已关闭' : outcome === 'state-match-unverified' ? '不能证明设备实际执行' : '只读查询超时')
    expect(screen.getByText(/结果不明，请先对账/)).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
  })
  it('locks repeated query clicks and reports matching fresh state without claiming action causation', async () => {
    const command = { commandId: 'pending-original', request: { deviceId: 'sim:light' }, status: 'unknown', updatedAt: 1 }
    const t = transport({ ...disabled, commands: [command] } as any)
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    t.request.mockImplementation(async (_path, init) => { if (init?.method === 'POST') await gate; return new Response(JSON.stringify({ ...disabled, commands: [{ ...command, status: init?.method === 'POST' ? 'observed' : 'unknown' }], ...(init?.method === 'POST' ? { reconciliation: { commandId: command.commandId, outcome: 'observed', checkedAt: 2000 } } : {}) })) })
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    const button = screen.getByRole('button', { name: '只读查询原命令状态' })
    fireEvent.click(button); fireEvent.click(button)
    await waitFor(() => expect(t.request).toHaveBeenCalledTimes(2)); expect((button as HTMLButtonElement).disabled).toBe(true)
    release(); const feedback = await screen.findByRole('status')
    expect(feedback.textContent).toContain('不证明是原动作造成')
    expect(feedback.textContent).toContain('没有重发命令')
    expect(screen.queryByRole('button', { name: '只读查询原命令状态' })).toBeNull()
  })
  it('keeps unknown after a query error without automatic retry', async () => {
    const t = transport({ ...disabled, commands: [{ commandId: 'pending-original', request: { deviceId: 'sim:light' }, status: 'unknown', updatedAt: 1 }] } as any)
    const original = t.request.getMockImplementation()!
    t.request.mockImplementation(async (path, init) => { if (init?.method === 'POST') throw new Error('secret network detail'); return original(path, init) })
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    fireEvent.click(screen.getByRole('button', { name: '只读查询原命令状态' }))
    expect((await screen.findByRole('alert')).textContent).toContain('原命令记录保留，没有重发')
    expect(screen.queryByText(/secret network detail/)).toBeNull()
    expect(t.request).toHaveBeenCalledTimes(2); expect(screen.getByText(/结果不明，请先对账/)).toBeTruthy()
  })

  it.each(['cancel-confirm', 'wrong-device', 'cancel-prompt'])('does not commit a manual release on %s and shows the exact command before confirmation', async choice => {
    const command = { commandId: 'pending-original', request: { deviceId: 'sim:light' }, status: 'unknown', updatedAt: 1 }
    const t = transport({ ...disabled, commands: [command] } as any)
    t.request.mockImplementation(async path => new Response(JSON.stringify(path.endsWith('/preview') ? { challengeId: 'preview-token', commandId: command.commandId, device: { deviceId: 'sim:light', homeId: 'simulation', adapter: 'simulator' }, desiredState: { power: true }, sentAt: 1000, warning: '旧动作仍可能迟到；不重发、不恢复授权。' } : { ...disabled, commands: [command] })))
    prompt.mockResolvedValue(choice === 'cancel-prompt' ? null : choice === 'wrong-device' ? 'another-device' : 'sim:light'); confirm.mockResolvedValue(false)
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    fireEvent.click(screen.getByRole('button', { name: '逐条人工处理隔离' }))
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    if (choice === 'cancel-confirm') { await waitFor(() => expect(confirm).toHaveBeenCalledOnce()); expect(confirm.mock.calls[0]?.[0]).toContain('pending-original'); expect(confirm.mock.calls[0]?.[0]).toContain('旧动作仍可能迟到') }
    else expect(confirm).not.toHaveBeenCalled()
    expect(t.request).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/结果不明，请先对账/)).toBeTruthy()
  })
  it('commits only a specifically previewed manual release after identity entry and risk confirmation, retaining unknown and disabled state', async () => {
    const command = { commandId: 'pending-original', request: { deviceId: 'sim:light' }, status: 'unknown', updatedAt: 1 }
    const t = transport({ ...disabled, commands: [command] } as any)
    t.request.mockImplementation(async path => new Response(JSON.stringify(path.endsWith('/preview') ? { challengeId: 'preview-token', commandId: command.commandId, device: { deviceId: 'sim:light', homeId: 'simulation', adapter: 'simulator' }, desiredState: { power: true }, sentAt: 1000, warning: '旧动作仍可能迟到，不重发、不恢复授权。' } : { ...disabled, blockingCount: path.endsWith('/confirm') ? 0 : 1, manuallyReleasedCount: path.endsWith('/confirm') ? 1 : 0, commands: [{ ...command, ...(path.endsWith('/confirm') ? { manualDisposition: { at: 2000, eventId: 'manual-event' } } : {}) }] })))
    prompt.mockResolvedValue('sim:light')
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('已关闭')
    fireEvent.click(screen.getByRole('button', { name: '逐条人工处理隔离' }))
    await screen.findByText('已人工处理隔离，执行结果仍未知；没有恢复授权。')
    expect(t.request.mock.calls.map(call => call[0])).toEqual(['/api/device-use/status', '/api/device-use/manual-resolution/preview', '/api/device-use/manual-resolution/confirm'])
    expect(JSON.parse(String(t.request.mock.calls[2]?.[1]?.body))).toEqual({ commandId: 'pending-original', challengeId: 'preview-token', deviceId: 'sim:light' })
    expect(confirm.mock.calls[0]?.[0]).toContain('原目标：{"power":true}')
    expect(confirm.mock.calls[0]?.[0]).toContain('现场核实此设备当前安全')
    expect(screen.getByText('已关闭')).toBeTruthy(); expect(screen.getByText(/结果不明，请先对账/)).toBeTruthy()
  })
  it('does not expose usable manual handling until Device Use is disabled', async () => {
    const t = transport({ ...disabled, enabled: true, ready: true, commands: [{ commandId: 'pending-original', request: { deviceId: 'sim:light' }, status: 'unknown', updatedAt: 1 }] } as any)
    render(<DeviceUseSettings transport={t.value} canManage />); await screen.findByText('仅模拟器，无真实硬件')
    const button = screen.getByRole('button', { name: '逐条人工处理隔离' }); expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button); expect(t.request).toHaveBeenCalledTimes(1); expect(prompt).not.toHaveBeenCalled()
  })

})
