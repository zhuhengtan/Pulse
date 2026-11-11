// Scene sandbox has its own component and parent-integration suite.
vi.mock('../src/SceneSandbox.js', () => ({ SceneSandbox: () => null }))
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalDiagnostics } from '../src/TerminalDiagnostics.js'
import { DeviceUseSettings } from '../src/DeviceUseSettings.js'
import type { PulseWebTransport } from '../src/transport.js'

vi.mock('../src/PulseControls.js', () => ({ usePulseDialogs: () => ({ confirm: vi.fn(async () => true), prompt: vi.fn() }) }))

const endpoint = '/api/device-use/terminal-diagnostics'
const disabled = {
  enabled: false, simulated: true, productionListener: false, persistentPairing: false, busy: false,
  cleanup: { state: 'idle', pendingCallbacks: 0 }, session: { state: 'absent' },
  callbacks: { asrPending: 0, asrQuarantined: 0, replyPending: 0, replyQuarantined: 0 }, timeline: [],
}
const enabled = { ...disabled, enabled: true }
const completed = { ...enabled, scenario: 'playback-complete', cleanup: { state: 'completed', pendingCallbacks: 0 },
  session: { state: 'closed', sessionId: 'simulation-1', generation: 2, reportedMuted: true },
  reply: { requestId: 'sim-request-1', phase: 'completed', ackCount: 2, chunkCount: 2, admissionConfirmed: true },
  timeline: [{ at: 1000, event: 'simulated-playback-completed' }],
}
const quarantined = { ...enabled, scenario: 'callback-quarantine', cleanup: { state: 'unconfirmed', pendingCallbacks: 2 },
  session: { state: 'closed' }, callbacks: { asrPending: 1, asrQuarantined: 1, replyPending: 1, replyQuarantined: 1 },
}
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function transport(initial: unknown = disabled) {
  const request = vi.fn(async (_path: string, _init?: RequestInit) => response(initial))
  const subscribe = vi.fn(() => () => {})
  return { value: { request, subscribe } as PulseWebTransport, request, subscribe }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const body = (init?: RequestInit) => JSON.parse(String(init?.body))
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {}; unobserve() {}; disconnect() {} }
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('memory-only terminal diagnostics', () => {
  it('makes zero requests and exposes no controls in a non-admin session', () => {
    const t = transport()
    render(<TerminalDiagnostics transport={t.value} canManage={false} />)
    expect(t.request).not.toHaveBeenCalled()
    expect(t.subscribe).not.toHaveBeenCalled()
    expect(screen.getByText(/模拟诊断仅限本机管理会话/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('only reads initially, requires explicit enable and states the simulation boundaries', async () => {
    const t = transport()
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('模拟诊断已关闭')
    expect(t.request).toHaveBeenCalledTimes(1)
    expect(t.request.mock.calls[0]?.[0]).toBe(endpoint)
    expect(t.request.mock.calls[0]?.[1]?.method).toBeUndefined()
    expect(button('运行所选模拟场景').disabled).toBe(true)
    expect(screen.getByText(/不调用真实模型、不访问麦克风或扬声器/)).toBeTruthy()
    expect(screen.getByText(/没有声学证据/)).toBeTruthy()
    expect(screen.getByText(/本诊断不会启用生产监听器/)).toBeTruthy()
    t.request.mockResolvedValueOnce(response(enabled))
    fireEvent.click(button('启用纯模拟诊断'))
    await screen.findByText('模拟诊断已启用')
    expect(t.request.mock.calls[1]?.[0]).toBe(endpoint)
    expect(body(t.request.mock.calls[1]?.[1])).toEqual({ action: 'enable' })
    expect(t.request.mock.calls[1]?.[1]?.method).toBe('POST')
    expect(button('运行所选模拟场景').disabled).toBe(false)
    expect(button('启用纯模拟诊断').disabled).toBe(true)
  })

  it.each(['playback-complete', 'playback-timeout', 'callback-quarantine'])('posts only the selected %s synthetic scenario', async scenario => {
    const t = transport(enabled)
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('模拟诊断已启用')
    fireEvent.change(screen.getByLabelText('终端模拟诊断场景'), { target: { value: scenario } })
    t.request.mockResolvedValueOnce(response(completed))
    fireEvent.click(button('运行所选模拟场景'))
    await screen.findByText(/simulated-playback-completed/)
    expect(body(t.request.mock.calls[1]?.[1])).toEqual({ action: 'run', scenario })
    expect(t.request.mock.calls.every(([path]) => path === endpoint)).toBe(true)
    expect(t.subscribe).not.toHaveBeenCalled()
    expect(screen.getByLabelText('模拟回复状态').textContent).toContain('仅协议回执')
    expect(screen.getByText(/已报告静音，不证明物理静音/)).toBeTruthy()
  })

  it.each([
    ['received', '已接收，不代表开始播放'],
    ['started', '报告开始，不代表播放完成'],
    ['completed', '报告完成，仅协议回执'],
    ['error', '播放错误，未确认完成'],
    ['unknown', '结果未知，不能声称已完成'],
    ['future-phase', '未知协议阶段，不能确认播放完成'],
  ])('does not conflate %s with acoustic evidence', async (phase, label) => {
    const t = transport({ ...completed, reply: { ...completed.reply, phase } })
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('模拟诊断已启用')
    expect(screen.getByLabelText('模拟回复状态').textContent).toContain(label)
    expect(screen.getByText(/分块回执：2 \/ 2，不代表播放完成/)).toBeTruthy()
    expect(screen.getByText(/received：终端已接收数据/)).toBeTruthy()
    expect(screen.getByText(/started：终端报告开始/)).toBeTruthy()
    expect(screen.getByText(/completed：终端报告完成/)).toBeTruthy()
    expect(screen.getByText(/error：终端报告播放错误/)).toBeTruthy()
    expect(screen.getByText(/unknown：超时或缺失确认/)).toBeTruthy()
  })

  it('shows timeout as unknown even after chunk acknowledgements and does not replay', async () => {
    const t = transport({ ...completed, scenario: 'playback-timeout', reply: { ...completed.reply, phase: 'unknown', errorCode: 'VOICE_TERMINAL_PLAYBACK_TIMEOUT' } })
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText(/等待播放回执超时，结果仍未知，不会自动重播/)
    expect(screen.getByLabelText('模拟回复状态').textContent).toContain('不能声称已完成')
    expect(t.request).toHaveBeenCalledTimes(1)
  })

  it('preserves quarantined callbacks as unconfirmed until explicitly released and checked', async () => {
    const t = transport(quarantined)
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('模拟诊断已启用')
    expect(screen.getByLabelText('模拟清理状态').textContent).toContain('清理未确认，仍有回调未退出')
    expect(screen.getByText(/转写回调：待退出 1，已隔离 1；回复回调：待退出 1，已隔离 1/)).toBeTruthy()
    expect(button('运行所选模拟场景').disabled).toBe(true)
    t.request.mockResolvedValueOnce(response({ ...quarantined, cleanup: { state: 'completed', pendingCallbacks: 0 }, callbacks: disabled.callbacks }))
    fireEvent.click(button('释放模拟回调并核验清理'))
    await waitFor(() => expect(screen.getByLabelText('模拟清理状态').textContent).toContain('清理已确认（仅进程内回调）'))
    expect(body(t.request.mock.calls[1]?.[1])).toEqual({ action: 'finish-cleanup' })
    expect(screen.queryByRole('button', { name: '释放模拟回调并核验清理' })).toBeNull()
    expect(button('运行所选模拟场景').disabled).toBe(false)
  })

  it('closing diagnostics does not erase unresolved cleanup or allow re-enabling over it', async () => {
    const t = transport(quarantined)
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('模拟诊断已启用')
    t.request.mockResolvedValueOnce(response({ ...quarantined, enabled: false }))
    fireEvent.click(button('关闭纯模拟诊断'))
    await screen.findByText('模拟诊断已关闭')
    expect(body(t.request.mock.calls[1]?.[1])).toEqual({ action: 'disable' })
    expect(screen.getByLabelText('模拟清理状态').textContent).toContain('清理未确认')
    expect(button('启用纯模拟诊断').disabled).toBe(true)
    expect(button('释放模拟回调并核验清理').disabled).toBe(true)
  })

  it('locks repeated actions and refresh while a write is in flight', async () => {
    const t = transport(enabled)
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('模拟诊断已启用')
    const gate = deferred<Response>()
    t.request.mockReturnValueOnce(gate.promise)
    const run = button('运行所选模拟场景')
    act(() => { run.click(); run.click() })
    fireEvent.click(button('刷新模拟状态'))
    expect(t.request).toHaveBeenCalledTimes(2)
    expect(run.disabled).toBe(true)
    expect(button('关闭纯模拟诊断').disabled).toBe(true)
    await act(async () => gate.resolve(response(completed)))
    expect(button('运行所选模拟场景').disabled).toBe(false)
    expect(t.request).toHaveBeenCalledTimes(2)
  })

  it('requires a manual read after uncertain write failure, hides raw errors, and never retries', async () => {
    const t = transport(enabled)
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('模拟诊断已启用')
    t.request.mockRejectedValueOnce(new Error('sensitive network failure detail'))
    fireEvent.click(button('运行所选模拟场景'))
    expect((await screen.findByRole('alert')).textContent).toContain('不会自动重试或重跑模拟')
    expect(screen.getByText('上次快照，当前状态未核验')).toBeTruthy()
    expect(screen.queryByText(/sensitive network failure detail/)).toBeNull()
    expect(button('运行所选模拟场景').disabled).toBe(true)
    expect(button('关闭纯模拟诊断').disabled).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(2)
    t.request.mockResolvedValueOnce(response(completed))
    fireEvent.click(button('刷新模拟状态'))
    await screen.findByText(/simulated-playback-completed/)
    expect(t.request.mock.calls[2]?.[1]?.method).toBeUndefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button('运行所选模拟场景').disabled).toBe(false)
    expect(t.request).toHaveBeenCalledTimes(3)
  })

  it('shows a failed initial read without enabling anything and supports explicit refresh', async () => {
    const t = transport()
    t.request.mockRejectedValueOnce(new Error('failed read'))
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByRole('alert')
    expect(button('启用纯模拟诊断').disabled).toBe(true)
    expect(t.request).toHaveBeenCalledTimes(1)
    fireEvent.click(button('刷新模拟状态'))
    await screen.findByText('模拟诊断已关闭')
    expect(t.request).toHaveBeenCalledTimes(2)
    expect(t.request.mock.calls[1]?.[1]?.method).toBeUndefined()
  })

  it.each([
    { ...disabled, simulated: false },
    { ...disabled, productionListener: true },
    { ...disabled, persistentPairing: true },
    { ...disabled, cleanup: { state: 'completed', pendingCallbacks: 2 } },
    { ...disabled, callbacks: {} },
  ])('fails closed for malformed or non-simulated responses', async snapshot => {
    const t = transport(snapshot)
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByRole('alert')
    expect(button('启用纯模拟诊断').disabled).toBe(true)
    expect(button('运行所选模拟场景').disabled).toBe(true)
    expect(screen.queryByText('模拟诊断已关闭')).toBeNull()
    expect(t.request).toHaveBeenCalledTimes(1)
  })

  it('does not poll while the backend is busy and refresh remains read-only', async () => {
    const t = transport({ ...enabled, busy: true, cleanup: { state: 'running', pendingCallbacks: 1 } })
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('后台模拟流程处理中，请手动刷新')
    expect(button('运行所选模拟场景').disabled).toBe(true)
    expect(button('关闭纯模拟诊断').disabled).toBe(true)
    vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(t.request).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    fireEvent.click(button('刷新模拟状态'))
    await waitFor(() => expect(t.request).toHaveBeenCalledTimes(2))
    expect(t.request.mock.calls[1]?.[1]?.method).toBeUndefined()
  })

  it('aborts and ignores old transport results without locking the new transport', async () => {
    const old = transport(), next = transport(enabled), gate = deferred<Response>()
    old.request.mockReturnValueOnce(gate.promise)
    const { rerender } = render(<TerminalDiagnostics transport={old.value} canManage />)
    const signal = old.request.mock.calls[0]?.[1]?.signal
    rerender(<TerminalDiagnostics transport={next.value} canManage />)
    await screen.findByText('模拟诊断已启用')
    expect(signal?.aborted).toBe(true)
    await act(async () => gate.resolve(response(disabled)))
    expect(screen.getByText('模拟诊断已启用')).toBeTruthy()
    expect(button('运行所选模拟场景').disabled).toBe(false)
    expect(next.request).toHaveBeenCalledTimes(1)
  })

  it('ignores a late failed mutation after changing transport and does not contaminate new state', async () => {
    const old = transport(enabled), next = transport(disabled), gate = deferred<Response>()
    const { rerender } = render(<TerminalDiagnostics transport={old.value} canManage />)
    await screen.findByText('模拟诊断已启用')
    old.request.mockReturnValueOnce(gate.promise)
    fireEvent.click(button('运行所选模拟场景'))
    const signal = old.request.mock.calls[1]?.[1]?.signal
    rerender(<TerminalDiagnostics transport={next.value} canManage />)
    await screen.findByText('模拟诊断已关闭')
    expect(signal?.aborted).toBe(true)
    await act(async () => gate.reject(new Error('late failure')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button('启用纯模拟诊断').disabled).toBe(false)
    expect(next.request).toHaveBeenCalledTimes(1)
  })

  it('makes no new calls after permission loss and ignores the old response when admin access returns', async () => {
    const t = transport(), gate = deferred<Response>()
    t.request.mockReturnValueOnce(gate.promise)
    const { rerender } = render(<TerminalDiagnostics transport={t.value} canManage />)
    const signal = t.request.mock.calls[0]?.[1]?.signal
    rerender(<TerminalDiagnostics transport={t.value} canManage={false} />)
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByRole('button')).toBeNull()
    expect(t.request).toHaveBeenCalledTimes(1)
    rerender(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('模拟诊断已关闭')
    await act(async () => gate.resolve(response(completed)))
    expect(screen.getByText('模拟诊断已关闭')).toBeTruthy()
    expect(screen.queryByLabelText('模拟回复状态')).toBeNull()
    expect(t.request).toHaveBeenCalledTimes(2)
  })

  it('aborts on unmount without disabling or repeating an in-flight action', async () => {
    const t = transport(enabled), gate = deferred<Response>()
    const { unmount } = render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText('模拟诊断已启用')
    t.request.mockReturnValueOnce(gate.promise)
    fireEvent.click(button('运行所选模拟场景'))
    const signal = t.request.mock.calls[1]?.[1]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => gate.resolve(response(completed)))
    expect(t.request).toHaveBeenCalledTimes(2)
  })
})


describe('Device Use settings integration with real terminal diagnostics', () => {
  it('reads diagnostics once without a POST or changing Device Use configuration', async () => {
    const t = transport()
    const deviceStatus = { enabled: false, ready: false, mode: 'simulator', devices: [], grants: [], commands: [] }
    t.request.mockImplementation(async (path, init) => {
      if (path === '/api/device-use/status') return response(deviceStatus)
      if (path === endpoint) return response(init?.method === 'POST' ? enabled : disabled)
      throw new Error(`Unexpected request: ${path}`)
    })
    render(<DeviceUseSettings transport={t.value} canManage />)
    await screen.findByText('模拟诊断已关闭')
    await screen.findByText('已关闭')
    expect(t.request.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1)
    expect(t.request.mock.calls.filter(([path]) => path === '/api/device-use/status')).toHaveLength(1)
    expect(t.request.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
    expect(button('运行所选模拟场景').disabled).toBe(true)
    fireEvent.click(button('启用纯模拟诊断'))
    await screen.findByText('模拟诊断已启用')
    const posts = t.request.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.[0]).toBe(endpoint)
    expect(body(posts[0]?.[1])).toEqual({ action: 'enable' })
    expect(t.request.mock.calls.some(([path]) => path === '/api/device-use/config')).toBe(false)
    expect(screen.getByText('已关闭')).toBeTruthy()
    expect(deviceStatus).toEqual({ enabled: false, ready: false, mode: 'simulator', devices: [], grants: [], commands: [] })
  })

  it('does not mount a diagnostic fetch under the non-admin settings boundary', () => {
    const t = transport()
    render(<DeviceUseSettings transport={t.value} canManage={false} />)
    expect(t.request).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '启用纯模拟诊断' })).toBeNull()
  })

  it('translates known timeline events without turning a stop request into physical evidence', async () => {
    const t = transport({ ...completed, timeline: [
      { at: 1000, event: 'playback-received' },
      { at: 1001, event: 'playback-completed' },
      { at: 1002, event: 'playback-stop-requested' },
    ] })
    render(<TerminalDiagnostics transport={t.value} canManage />)
    await screen.findByText(/模拟终端报告播放完成，无声学证据/)
    expect(screen.getByText(/已请求停止模拟播放，不是物理停止证明/)).toBeTruthy()
    expect(screen.queryByText(/playback-completed/)).toBeNull()
  })
})
