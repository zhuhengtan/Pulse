import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { VoiceSettings } from '../src/VoiceSettings.js'
import { voiceFixture } from './fixtures/voice.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  globalThis.ResizeObserver = class { observe() {}; unobserve() {}; disconnect() {} }
})
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'pulseDesktop'); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function show({ selected = '', pendingPreview = false } = {}) {
  Object.defineProperty(window, 'pulseDesktop', { value: {}, configurable: true })
  const fixture = voiceFixture({ enabled: true }), paths: string[] = []
  let finish!: (value: Response) => void
  const transport: PulseWebTransport = { ...fixture.transport, request: async (path, init) => {
    paths.push(path)
    if (path === '/api/desktop/voice/preview-output' && pendingPreview) return new Promise<Response>(resolve => { finish = resolve })
    const response = await fixture.transport.request(path, init)
    const value = await response.json()
    if (path === '/api/voice/config') value.speakerId = selected
    if (path.startsWith('/api/desktop/voice/')) { value.outputDevices = [{ id: 'saved-speaker', label: '房间音箱' }]; value.outputState = { state: 'ready', deviceId: selected } }
    return Response.json(value, { status: response.status })
  } }
  const view = render(<PulseDesignSystem><VoiceSettings transport={transport} canManage/></PulseDesignSystem>)
  return { ...fixture, paths, view, finishPreview: () => finish(Response.json({ ok: true })) }
}
it('exposes a separate output selector and refreshes audio devices without saving drafts or starting capture', async () => {
  const f = show()
  fireEvent.click(await screen.findByRole('tab', { name: '唤醒与声纹' }))
  expect(await screen.findByLabelText(/播报扬声器/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('助手名字'), { target: { value: '尚未保存' } })
  fireEvent.click(screen.getByRole('button', { name: '刷新音频设备（不打开麦克风）' }))
  await waitFor(() => expect(f.paths).toContain('/api/desktop/voice/list-devices'))
  expect(f.calls.some(call => call.path === '/api/voice/config' && call.body)).toBe(false)
  expect(f.paths).not.toContain('/api/desktop/voice/resume')
  expect(f.paths).not.toContain('/api/desktop/voice/wake-settings')
  expect(screen.getByLabelText('助手名字')).toHaveProperty('value', '尚未保存')
})
it('previews a saved non-default output through the desktop audio host instead of a different-origin UI player', async () => {
  const Audio = vi.fn(); vi.stubGlobal('Audio', Audio)
  const f = show({ selected: 'saved-speaker' })
  fireEvent.click(await screen.findByRole('button', { name: '试听音色' }))
  await waitFor(() => expect(f.paths).toContain('/api/desktop/voice/preview-output'))
  expect(Audio).not.toHaveBeenCalled()
  expect(f.calls.find(call => call.path === '/api/desktop/voice/preview-output')?.body).toEqual({ audio: '', mime: 'audio/wav' })
  expect(await screen.findByText('试听已完成')).toBeTruthy()
})
it('stops a pending desktop preview on leaving the settings page and does not replay late completion', async () => {
  const Audio = vi.fn(); vi.stubGlobal('Audio', Audio)
  const f = show({ selected: 'saved-speaker', pendingPreview: true })
  fireEvent.click(await screen.findByRole('button', { name: '试听音色' }))
  await waitFor(() => expect(f.paths).toContain('/api/desktop/voice/preview-output'))
  f.view.unmount()
  await waitFor(() => expect(f.paths).toContain('/api/desktop/voice/preview-stop'))
  f.finishPreview(); await Promise.resolve(); expect(Audio).not.toHaveBeenCalled()
})
