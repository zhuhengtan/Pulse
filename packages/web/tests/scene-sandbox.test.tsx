import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SceneSandbox } from '../src/SceneSandbox.js'
import { DeviceUseSettings } from '../src/DeviceUseSettings.js'
import type { PulseWebTransport } from '../src/transport.js'

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn<(...args: unknown[]) => Promise<boolean>>() }))
vi.mock('../src/PulseControls.js', () => ({ usePulseDialogs: () => ({ confirm }) }))
vi.mock('../src/TerminalDiagnostics.js', () => ({ TerminalDiagnostics: () => null }))
const endpoint = '/api/device-use/scene-sandbox'
const scene = { name: '模拟双灯场景', steps: [
  { deviceId: 'scene:lamp-a', desiredState: { power: true, brightness: 30 } },
  { deviceId: 'scene:lamp-b', desiredState: { power: true, brightness: 60 } },
] }
const disabled = {
  enabled: false, busy: false, simulated: true, realDevices: false, automaticRollback: false, automaticRetry: false,
  version: 1, scene, devices: [
    { deviceId: 'scene:lamp-a', name: '虚拟灯 A', state: { power: false, brightness: 0 } },
    { deviceId: 'scene:lamp-b', name: '虚拟灯 B', state: { power: false, brightness: 0 } },
  ], cleanup: { state: 'idle' },
}
const enabled = { ...disabled, enabled: true }
const previewed = () => ({ ...enabled, preview: {
  previewId: 'preview-1', version: 1, expiresAt: Date.now() + 60_000, atomic: false,
  steps: scene.steps.map((step, index) => ({ index, deviceId: step.deviceId, from: { power: false, brightness: 0 }, to: step.desiredState })),
} })
const result = (secondStatus = 'observed') => ({ ...previewed(), run: {
  runId: 'run-1', version: 1, status: 'completed', atomic: false,
  steps: [
    { index: 0, deviceId: 'scene:lamp-a', status: 'observed', commandId: 'command-1' },
    { index: 1, deviceId: 'scene:lamp-b', status: secondStatus, commandId: 'command-2', ...(secondStatus === 'observed' ? {} : { reason: 'SIMULATED_FAILURE' }) },
  ],
} })
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function transport(initial: unknown = disabled) {
  const request = vi.fn(async (_path: string, _init?: RequestInit) => response(initial))
  const subscribe = vi.fn(() => () => {})
  return { value: { request, subscribe } as PulseWebTransport, request, subscribe }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const body = (init?: RequestInit) => JSON.parse(String(init?.body))
const input = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } })
async function save(t: ReturnType<typeof transport>, snapshot: unknown = enabled) {
  t.request.mockResolvedValueOnce(response(snapshot))
  fireEvent.click(button('保存模拟场景'))
  await screen.findByText('草稿已明确保存；执行仍须新的有效预览和确认。')
}
async function ready(t: ReturnType<typeof transport>, snapshot = previewed()) {
  await screen.findByText('场景沙盒已启用')
  await save(t)
  t.request.mockResolvedValueOnce(response(snapshot))
  fireEvent.click(button('生成场景预览'))
  await screen.findByText('预览有效，仅代表模拟计划，尚未执行。')
}
beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true)
  globalThis.ResizeObserver = class { observe() {}; unobserve() {}; disconnect() {} }
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('isolated simulated scene sandbox', () => {
  it('makes zero API or subscription calls without local management permission', () => {
    const t = transport()
    render(<SceneSandbox transport={t.value} canManage={false} />)
    expect(t.request).not.toHaveBeenCalled()
    expect(t.subscribe).not.toHaveBeenCalled()
    expect(screen.getByText(/场景沙盒仅限本机管理会话/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('only reads initially, starts disabled and requires separate enable, save and preview', async () => {
    const t = transport()
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('场景沙盒已关闭')
    expect(t.request).toHaveBeenCalledTimes(1)
    expect(t.request.mock.calls[0]?.[0]).toBe(endpoint)
    expect(t.request.mock.calls[0]?.[1]?.method).toBeUndefined()
    expect(screen.getByText(/不连接真实设备、Home Assistant、模型、授权或自动化/)).toBeTruthy()
    expect(screen.getByText(/步骤并行执行，非原子操作/)).toBeTruthy()
    expect(button('保存模拟场景').disabled).toBe(true)
    expect(button('生成场景预览').disabled).toBe(true)
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    expect((screen.getByLabelText('模拟步骤 1 亮度') as HTMLInputElement).value).toBe('30')
    expect((screen.getByLabelText('模拟步骤 2 亮度') as HTMLInputElement).value).toBe('60')
    t.request.mockResolvedValueOnce(response(enabled))
    fireEvent.click(button('启用场景沙盒'))
    await screen.findByText('场景沙盒已启用')
    expect(body(t.request.mock.calls[1]?.[1])).toEqual({ action: 'enable' })
    expect(button('生成场景预览').disabled).toBe(true)
    await save(t)
    expect(body(t.request.mock.calls[2]?.[1])).toEqual({ action: 'configure', ...scene })
    expect(button('生成场景预览').disabled).toBe(false)
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    t.request.mockResolvedValueOnce(response(previewed()))
    fireEvent.click(button('生成场景预览'))
    await screen.findByText('预览有效，仅代表模拟计划，尚未执行。')
    expect(body(t.request.mock.calls[3]?.[1])).toEqual({ action: 'preview' })
    expect(button('确认并执行模拟场景').disabled).toBe(false)
    expect(t.request).toHaveBeenCalledTimes(4)
    expect(t.request.mock.calls.every(([path]) => path === endpoint)).toBe(true)
    expect(t.subscribe).not.toHaveBeenCalled()
  })

  it.each(['none', 'reject-second', 'disconnect-second'])('confirms and posts only a strict execute object for %s', async fault => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await ready(t)
    input('第二步故障模拟', fault)
    t.request.mockResolvedValueOnce(response(result(fault === 'none' ? 'observed' : fault === 'reject-second' ? 'failed' : 'unknown')))
    fireEvent.click(button('确认并执行模拟场景'))
    await screen.findByLabelText('模拟批次结果')
    expect(confirm).toHaveBeenCalledTimes(1)
    const wording = String(confirm.mock.calls[0]?.[0])
    for (const part of ['纯模拟', '并行执行', '非原子', '没有自动回滚', '真实设备动作', '虚拟灯 A', '亮度 30%', '亮度 60%']) expect(wording).toContain(part)
    expect(body(t.request.mock.calls[3]?.[1])).toEqual({ action: 'execute', previewId: 'preview-1', version: 1, fault })
    expect(t.request.mock.calls[3]?.[1]?.method).toBe('POST')
    expect(screen.getByLabelText('模拟批次状态').textContent).toContain('已结束，不代表每一步成功')
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(4)
  })

  it('cancels confirmation without sending a write and keeps the valid preview', async () => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await ready(t)
    confirm.mockResolvedValueOnce(false)
    fireEvent.click(button('确认并执行模拟场景'))
    await waitFor(() => expect(button('确认并执行模拟场景').disabled).toBe(false))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(t.request).toHaveBeenCalledTimes(3)
    expect(screen.queryByLabelText('模拟批次结果')).toBeNull()
  })

  it('rejects an interrupted confirmation without treating it as a sent request', async () => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await ready(t)
    confirm.mockRejectedValueOnce(new Error('dialog interrupted'))
    fireEvent.click(button('确认并执行模拟场景'))
    expect((await screen.findByRole('alert')).textContent).toBe('确认未完成，没有发送执行请求。')
    expect(button('确认并执行模拟场景').disabled).toBe(false)
    expect(t.request).toHaveBeenCalledTimes(3)
  })

  it('guards double-clicks while confirming and while the execution response is pending', async () => {
    const t = transport(enabled), dialog = deferred<boolean>(), execution = deferred<Response>()
    render(<SceneSandbox transport={t.value} canManage />)
    await ready(t)
    confirm.mockReturnValueOnce(dialog.promise)
    t.request.mockReturnValueOnce(execution.promise)
    const run = button('确认并执行模拟场景')
    act(() => { run.click(); run.click() })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(t.request).toHaveBeenCalledTimes(3)
    expect(button('刷新场景沙盒状态').disabled).toBe(true)
    expect(button('关闭并清理场景沙盒').disabled).toBe(true)
    await act(async () => dialog.resolve(true))
    act(() => { run.click(); run.click(); button('刷新场景沙盒状态').click() })
    expect(t.request).toHaveBeenCalledTimes(4)
    await act(async () => execution.resolve(response(result())))
    expect(run.disabled).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(4)
  })

  it('invalidates both save and preview when editing, even when the edit is reverted', async () => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await ready(t)
    input('模拟步骤 1 亮度', '31')
    input('模拟步骤 1 亮度', '30')
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    expect(button('生成场景预览').disabled).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(3)
    await save(t)
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    expect(button('生成场景预览').disabled).toBe(false)
  })

  it.each([
    ['模拟场景名称', ''], ['模拟场景名称', ' '.repeat(3)], ['模拟场景名称', 'a'.repeat(61)],
    ['模拟步骤 1 亮度', '-1'], ['模拟步骤 1 亮度', '101'], ['模拟步骤 1 亮度', '0'],
    ['模拟步骤 1 开关', 'off'], ['模拟步骤 2 设备', 'scene:lamp-a'],
  ])('does not save invalid draft %s = %s', async (name, value) => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('场景沙盒已启用')
    input(name, value)
    expect(button('保存模拟场景').disabled).toBe(true)
    expect(screen.getByText(/草稿无效/)).toBeTruthy()
    fireEvent.click(button('保存模拟场景'))
    expect(t.request).toHaveBeenCalledTimes(1)
  })

  it('supports one fixed lamp, omitted power and fractional positive brightness without arbitrary fields', async () => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('场景沙盒已启用')
    input('第二步故障模拟', 'disconnect-second')
    fireEvent.click(button('移除模拟步骤 1'))
    input('模拟场景名称', ' 单灯预览 ')
    input('模拟步骤 1 开关', '')
    input('模拟步骤 1 亮度', '42.5')
    const changedScene = { name: '单灯预览', steps: [{ deviceId: 'scene:lamp-b', desiredState: { brightness: 42.5 } }] }
    await save(t, { ...enabled, version: 2, scene: changedScene })
    expect(body(t.request.mock.calls[1]?.[1])).toEqual({ action: 'configure', ...changedScene })
    expect((screen.getByLabelText('第二步故障模拟') as HTMLSelectElement).value).toBe('none')
    expect((screen.getByLabelText('第二步故障模拟') as HTMLSelectElement).disabled).toBe(true)
    expect(button('移除模拟步骤 1').disabled).toBe(true)
    const options = within(screen.getByLabelText('模拟步骤 1 设备')).getAllByRole('option')
    expect(options.map(option => (option as HTMLOptionElement).value)).toEqual(['scene:lamp-a', 'scene:lamp-b'])
    fireEvent.click(button('添加第二盏虚拟灯'))
    expect((screen.getByLabelText('模拟步骤 2 设备') as HTMLSelectElement).value).toBe('scene:lamp-a')
    expect(button('生成场景预览').disabled).toBe(true)
  })

  it('rejects empty desired state and allows an explicit coherent off state', async () => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('场景沙盒已启用')
    input('模拟步骤 1 开关', '')
    input('模拟步骤 1 亮度', '')
    expect(button('保存模拟场景').disabled).toBe(true)
    input('模拟步骤 1 开关', 'off')
    input('模拟步骤 1 亮度', '0')
    expect(button('保存模拟场景').disabled).toBe(false)
  })

  it('expires the preview locally without polling or sending any command', async () => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('场景沙盒已启用')
    await save(t)
    vi.useFakeTimers()
    t.request.mockResolvedValueOnce(response(previewed()))
    await act(async () => { fireEvent.click(button('生成场景预览')) })
    expect(button('确认并执行模拟场景').disabled).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001) })
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    expect(screen.getByText(/预览不可用于执行/)).toBeTruthy()
    expect(t.request).toHaveBeenCalledTimes(3)
  })

  it('rechecks preview expiry after the confirmation dialog resolves', async () => {
    const t = transport(enabled), dialog = deferred<boolean>()
    render(<SceneSandbox transport={t.value} canManage />)
    const snapshot = previewed()
    await ready(t, snapshot)
    confirm.mockReturnValueOnce(dialog.promise)
    fireEvent.click(button('确认并执行模拟场景'))
    vi.spyOn(Date, 'now').mockReturnValue(snapshot.preview.expiresAt + 1)
    await act(async () => dialog.resolve(true))
    expect((await screen.findByRole('alert')).textContent).toContain('预览已过期或状态已变化，未执行')
    expect(t.request).toHaveBeenCalledTimes(3)
  })

  it.each(['failed', 'unknown', 'not-accepted', 'future-status'])('retains partial %s evidence in configuration order without inferring group success', async status => {
    const snapshot = result(status)
    snapshot.run.steps.reverse()
    const t = transport(snapshot)
    render(<SceneSandbox transport={t.value} canManage />)
    const run = await screen.findByLabelText('模拟批次结果')
    const rows = within(run).getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('虚拟灯 A')
    expect(rows[0]?.textContent).toContain('模拟状态已核对，不代表真实设备执行')
    expect(rows[1]?.textContent).toContain('虚拟灯 B')
    expect(rows[1]?.textContent).toContain(status)
    expect(rows[1]?.textContent).toContain('SIMULATED_FAILURE')
    expect(screen.getByLabelText('模拟批次状态').textContent).toContain('不代表每一步成功')
    if (status === 'unknown' || status === 'future-status') {
      expect(button('保存模拟场景').disabled).toBe(true)
      expect(button('生成场景预览').disabled).toBe(true)
      expect(screen.getByText(/存在未决模拟结果/)).toBeTruthy()
    }
    expect(button('关闭并清理场景沙盒').disabled).toBe(false)
    expect(t.request).toHaveBeenCalledTimes(1)
  })

  it('requires a manual read after uncertain execution and never reuses the consumed preview', async () => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await ready(t)
    t.request.mockRejectedValueOnce(new Error('private failure detail'))
    fireEvent.click(button('确认并执行模拟场景'))
    expect((await screen.findByRole('alert')).textContent).toContain('不会自动重试、重发或回滚')
    expect(screen.queryByText(/private failure detail/)).toBeNull()
    expect(screen.getByText('上次快照，当前状态未核验')).toBeTruthy()
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    expect(button('关闭并清理场景沙盒').disabled).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(4)
    t.request.mockResolvedValueOnce(response(result('unknown')))
    fireEvent.click(button('刷新场景沙盒状态'))
    await screen.findByLabelText('模拟批次结果')
    expect(t.request.mock.calls[4]?.[1]?.method).toBeUndefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    expect(button('生成场景预览').disabled).toBe(true)
    expect(button('关闭并清理场景沙盒').disabled).toBe(false)
    expect(t.request).toHaveBeenCalledTimes(5)
  })

  it('manual refresh cannot turn a previously returned preview into execution authorization', async () => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await ready(t)
    t.request.mockResolvedValueOnce(response(previewed()))
    fireEvent.click(button('刷新场景沙盒状态'))
    await waitFor(() => expect(button('刷新场景沙盒状态').disabled).toBe(false))
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    expect(button('生成场景预览').disabled).toBe(false)
    expect(t.request.mock.calls[3]?.[1]?.method).toBeUndefined()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('closes only through an explicit action and shows cleanup separately from enabled state', async () => {
    const t = transport(result('unknown'))
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByLabelText('模拟批次结果')
    t.request.mockResolvedValueOnce(response({ ...result('unknown'), enabled: false, cleanup: { state: 'unconfirmed' } }))
    fireEvent.click(button('关闭并清理场景沙盒'))
    await screen.findByText('场景沙盒已关闭')
    expect(body(t.request.mock.calls[1]?.[1])).toEqual({ action: 'disable' })
    expect(screen.getByLabelText('场景沙盒清理状态').textContent).toContain('模拟清理未确认')
    expect(screen.getByLabelText('模拟结果步骤 2').textContent).toContain('unknown')
    expect(button('启用场景沙盒').disabled).toBe(true)
    expect(screen.getByText(/不会撤销已发生的真实动作/)).toBeTruthy()
  })

  it('requires a manual read before explicitly retrying unconfirmed cleanup while already disabled', async () => {
    const t = transport(result('unknown'))
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByLabelText('模拟批次结果')
    t.request.mockRejectedValueOnce(new Error('cleanup failed after disabling'))
    fireEvent.click(button('关闭并清理场景沙盒'))
    await screen.findByRole('alert')
    expect(button('关闭并清理场景沙盒').disabled).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(2)
    t.request.mockResolvedValueOnce(response({ ...result('unknown'), enabled: false, cleanup: { state: 'unconfirmed' } }))
    fireEvent.click(button('刷新场景沙盒状态'))
    await screen.findByText('场景沙盒已关闭')
    expect(t.request.mock.calls[2]?.[1]?.method).toBeUndefined()
    expect(button('启用场景沙盒').disabled).toBe(true)
    expect(button('关闭并清理场景沙盒').disabled).toBe(false)
    expect(screen.getByLabelText('模拟结果步骤 2').textContent).toContain('unknown')
    t.request.mockResolvedValueOnce(response({ ...result('unknown'), enabled: false, cleanup: { state: 'completed' } }))
    fireEvent.click(button('关闭并清理场景沙盒'))
    await waitFor(() => expect(screen.getByLabelText('场景沙盒清理状态').textContent).toContain('模拟清理已确认'))
    expect(body(t.request.mock.calls[3]?.[1])).toEqual({ action: 'disable' })
    expect(button('启用场景沙盒').disabled).toBe(false)
    expect(screen.getByLabelText('模拟结果步骤 2').textContent).toContain('unknown')
    expect(t.request).toHaveBeenCalledTimes(4)
  })

  it('does not poll or permit mutations while the backend is busy', async () => {
    const t = transport({ ...enabled, busy: true })
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('模拟批次处理中，请手动刷新')
    for (const name of ['保存模拟场景', '生成场景预览', '确认并执行模拟场景', '关闭并清理场景沙盒']) expect(button(name).disabled).toBe(true)
    vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(t.request).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    fireEvent.click(button('刷新场景沙盒状态'))
    await waitFor(() => expect(t.request).toHaveBeenCalledTimes(2))
    expect(t.request.mock.calls[1]?.[1]?.method).toBeUndefined()
  })

  it('recovers a failed initial read only through explicit read-only refresh', async () => {
    const t = transport()
    t.request.mockRejectedValueOnce(new Error('read failed'))
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByRole('alert')
    expect(button('启用场景沙盒').disabled).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(1)
    fireEvent.click(button('刷新场景沙盒状态'))
    await screen.findByText('场景沙盒已关闭')
    expect(t.request.mock.calls[1]?.[1]?.method).toBeUndefined()
  })

  it.each([
    { ...disabled, simulated: false }, { ...disabled, realDevices: true }, { ...disabled, automaticRollback: true }, { ...disabled, automaticRetry: true },
    { ...disabled, version: -1 }, { ...disabled, scene: { ...scene, steps: [] } },
    { ...disabled, scene: { ...scene, steps: [{ deviceId: 'ha:light.real', desiredState: { power: true } }] } },
    { ...disabled, devices: [] }, { ...disabled, cleanup: { state: 'assumed' } },
    { ...previewed(), preview: { ...previewed().preview, atomic: true } },
    { ...result(), run: { ...result().run, atomic: true } },
    { ...result(), run: { ...result().run, steps: [{ index: 0, deviceId: 'scene:lamp-a', status: 'observed' }, { index: 0, deviceId: 'scene:lamp-b', status: 'failed' }] } },
  ])('fails closed on unsafe or malformed snapshots', async snapshot => {
    const t = transport(snapshot)
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByRole('alert')
    expect(button('启用场景沙盒').disabled).toBe(true)
    expect(button('保存模拟场景').disabled).toBe(true)
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    expect(screen.queryByLabelText('模拟批次结果')).toBeNull()
    expect(t.request).toHaveBeenCalledTimes(1)
  })

  it('does not trust a save response that differs from the submitted scene', async () => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('场景沙盒已启用')
    t.request.mockResolvedValueOnce(response({ ...enabled, scene: { ...scene, name: 'different scene' } }))
    fireEvent.click(button('保存模拟场景'))
    await screen.findByRole('alert')
    expect(button('生成场景预览').disabled).toBe(true)
    expect(screen.queryByDisplayValue('different scene')).toBeNull()
  })

  it.each(['version', 'steps', 'target'])('never executes a preview inconsistent with the saved %s', async mismatch => {
    const t = transport(enabled)
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('场景沙盒已启用')
    await save(t)
    const snapshot = previewed()
    if (mismatch === 'version') snapshot.preview.version = 2
    else if (mismatch === 'target') snapshot.preview.steps[0]!.to = { power: true, brightness: 99 }
    else snapshot.preview.steps.reverse().forEach((step, index) => { step.index = index })
    t.request.mockResolvedValueOnce(response(snapshot))
    fireEvent.click(button('生成场景预览'))
    await screen.findByLabelText('场景预览')
    expect(button('确认并执行模拟场景').disabled).toBe(true)
  })

  it('allows explicit reset after completed cleanup while preserving old unknown evidence until re-enable', async () => {
    const t = transport({ ...result('unknown'), enabled: false, cleanup: { state: 'completed' } })
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('场景沙盒已关闭')
    expect(button('启用场景沙盒').disabled).toBe(false)
    expect(screen.getByLabelText('模拟结果步骤 2').textContent).toContain('unknown')
    t.request.mockResolvedValueOnce(response({ ...enabled, version: 3 }))
    fireEvent.click(button('启用场景沙盒'))
    await screen.findByText('场景沙盒已启用')
    expect(body(t.request.mock.calls[1]?.[1])).toEqual({ action: 'enable' })
    expect(screen.queryByLabelText('模拟批次结果')).toBeNull()
    expect(button('生成场景预览').disabled).toBe(true)
    expect(button('确认并执行模拟场景').disabled).toBe(true)
  })

  it('shows pending steps as not yet admitted, never as accepted', async () => {
    const t = transport({ ...result('pending'), busy: true, run: { ...result('pending').run, status: 'running' } })
    render(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('模拟批次处理中，请手动刷新')
    expect(screen.getByLabelText('模拟结果步骤 2').textContent).toContain('尚未受理')
    expect(screen.getByLabelText('模拟结果步骤 2').textContent).not.toContain('已受理')
    expect(button('生成场景预览').disabled).toBe(true)
  })

  it('aborts and ignores stale initial results after transport changes', async () => {
    const old = transport(), next = transport(enabled), gate = deferred<Response>()
    old.request.mockReturnValueOnce(gate.promise)
    const { rerender } = render(<SceneSandbox transport={old.value} canManage />)
    const signal = old.request.mock.calls[0]?.[1]?.signal
    rerender(<SceneSandbox transport={next.value} canManage />)
    await screen.findByText('场景沙盒已启用')
    expect(signal?.aborted).toBe(true)
    await act(async () => gate.resolve(response(disabled)))
    expect(screen.getByText('场景沙盒已启用')).toBeTruthy()
    expect(button('保存模拟场景').disabled).toBe(false)
    expect(next.request).toHaveBeenCalledTimes(1)
  })

  it('ignores late execution failure after a transport change', async () => {
    const old = transport(enabled), next = transport(disabled), gate = deferred<Response>()
    const { rerender } = render(<SceneSandbox transport={old.value} canManage />)
    await ready(old)
    old.request.mockReturnValueOnce(gate.promise)
    fireEvent.click(button('确认并执行模拟场景'))
    await waitFor(() => expect(old.request).toHaveBeenCalledTimes(4))
    const signal = old.request.mock.calls[3]?.[1]?.signal
    rerender(<SceneSandbox transport={next.value} canManage />)
    await screen.findByText('场景沙盒已关闭')
    expect(signal?.aborted).toBe(true)
    await act(async () => gate.reject(new Error('stale execution error')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button('启用场景沙盒').disabled).toBe(false)
    expect(next.request).toHaveBeenCalledTimes(1)
  })

  it.each(['transport', 'permission', 'unmount'])('cannot send a pending confirmation after %s changes', async change => {
    const old = transport(enabled), next = transport(), dialog = deferred<boolean>()
    const { rerender, unmount } = render(<SceneSandbox transport={old.value} canManage />)
    await ready(old)
    confirm.mockReturnValueOnce(dialog.promise)
    fireEvent.click(button('确认并执行模拟场景'))
    if (change === 'transport') { rerender(<SceneSandbox transport={next.value} canManage />); await screen.findByText('场景沙盒已关闭') }
    else if (change === 'permission') rerender(<SceneSandbox transport={old.value} canManage={false} />)
    else unmount()
    await act(async () => dialog.resolve(true))
    expect(old.request).toHaveBeenCalledTimes(3)
    expect(next.request).toHaveBeenCalledTimes(change === 'transport' ? 1 : 0)
    expect(screen.queryByText(/模拟批次已结束/)).toBeNull()
  })

  it('makes no calls after permission loss and starts a fresh read if access returns', async () => {
    const t = transport(enabled), gate = deferred<Response>()
    t.request.mockReturnValueOnce(gate.promise)
    const { rerender } = render(<SceneSandbox transport={t.value} canManage />)
    const signal = t.request.mock.calls[0]?.[1]?.signal
    rerender(<SceneSandbox transport={t.value} canManage={false} />)
    expect(signal?.aborted).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(1)
    rerender(<SceneSandbox transport={t.value} canManage />)
    await screen.findByText('场景沙盒已启用')
    await act(async () => gate.resolve(response(disabled)))
    expect(screen.getByText('场景沙盒已启用')).toBeTruthy()
    expect(button('生成场景预览').disabled).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(2)
  })

  it('aborts a pending read on unmount and ignores its late response', async () => {
    const t = transport(), gate = deferred<Response>()
    t.request.mockReturnValueOnce(gate.promise)
    const { unmount } = render(<SceneSandbox transport={t.value} canManage />)
    const signal = t.request.mock.calls[0]?.[1]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => gate.resolve(response(enabled)))
    expect(t.request).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('场景沙盒已启用')).toBeNull()
  })
})


describe('Device Use settings integration with real scene sandbox', () => {
  it('mounts with reads only and enabling the sandbox never changes Device Use configuration', async () => {
    const t = transport()
    const deviceStatus = { enabled: false, ready: false, mode: 'simulator', devices: [], grants: [], commands: [] }
    t.request.mockImplementation(async (path, init) => {
      if (path === '/api/device-use/status') return response(deviceStatus)
      if (path === endpoint) return response(init?.method === 'POST' ? enabled : disabled)
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<DeviceUseSettings transport={t.value} canManage />)
    await screen.findByText('场景沙盒已关闭')
    await screen.findByText('已关闭')
    expect(t.request.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1)
    expect(t.request.mock.calls.filter(([path]) => path === '/api/device-use/status')).toHaveLength(1)
    expect(t.request.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
    expect(button('确认并执行模拟场景').disabled).toBe(true)
    fireEvent.click(button('启用场景沙盒'))
    await screen.findByText('场景沙盒已启用')
    const posts = t.request.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.[0]).toBe(endpoint)
    expect(body(posts[0]?.[1])).toEqual({ action: 'enable' })
    expect(t.request.mock.calls.some(([path]) => path === '/api/device-use/config')).toBe(false)
    expect(screen.getByText('已关闭')).toBeTruthy()
    expect(deviceStatus).toEqual({ enabled: false, ready: false, mode: 'simulator', devices: [], grants: [], commands: [] })
  })

  it('does not fetch the sandbox at the parent non-admin settings boundary', () => {
    const t = transport()
    render(<DeviceUseSettings transport={t.value} canManage={false} />)
    expect(t.request).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '启用场景沙盒' })).toBeNull()
  })
})
