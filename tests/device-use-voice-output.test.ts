import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { DeviceVoiceController } from '../packages/desktop/src/voice/device-controller.mjs'
import { voiceConfigSchema } from '../packages/server/src/voice/service.js'

function renderer(options: { noSink?: boolean; sinkError?: Error; sinkGate?: Promise<void> } = {}) {
  let command!: (value: unknown) => Promise<void>, change!: () => void
  let outputs = [{ kind: 'audiooutput', deviceId: 'desk-speaker', label: '桌面音箱' }]
  const send = vi.fn(), players: any[] = [], getUserMedia = vi.fn()
  class Audio {
    onended: (() => void) | null = null; onerror: (() => void) | null = null; src: string
    setSinkId = options.noSink ? undefined : vi.fn(async (_id: string) => { if (options.sinkError) throw options.sinkError; await options.sinkGate })
    play = vi.fn(async () => {}); pause = vi.fn()
    constructor(src: string) { this.src = src; players.push(this) }
  }
  runInNewContext(readFileSync(new URL('../packages/desktop/src/voice/audio.js', import.meta.url), 'utf8'), {
    window: { voiceAudio: { receive: (callback: any) => { command = callback }, send } },
    navigator: { mediaDevices: { getUserMedia, enumerateDevices: async () => outputs, addEventListener: (_: string, callback: () => void) => { change = callback } } },
    Audio, Blob, atob, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: vi.fn() },
  })
  const chunk = (id: string) => command({ type: 'speech-chunk', id, sequence: 0, audio: 'AA==', mime: 'audio/wav' })
  return { command, send, players, getUserMedia, chunk, disconnect: () => { outputs = []; change() }, reconnect: () => { outputs = [{ kind: 'audiooutput', deviceId: 'desk-speaker', label: '桌面音箱' }]; change() } }
}
it('defaults old voice settings to system output and supports independent saved output IDs', () => {
  expect(voiceConfigSchema.parse({}).speakerId).toBe('')
  expect(voiceConfigSchema.parse({ microphoneId: 'usb-mic', speakerId: 'bt-speaker' })).toMatchObject({ microphoneId: 'usb-mic', speakerId: 'bt-speaker' })
  expect(() => voiceConfigSchema.parse({ speakerId: 'a'.repeat(501) })).toThrow()
})
it('enumerates speakers without opening a microphone and binds every chunk before playback', async () => {
  const f = renderer(); await f.command({ type: 'enumerate-devices' })
  expect(f.getUserMedia).not.toHaveBeenCalled()
  expect(f.send).toHaveBeenCalledWith({ type: 'output-devices', devices: [{ id: 'desk-speaker', label: '桌面音箱' }] })
  await f.command({ type: 'select-output', deviceId: 'desk-speaker' })
  await f.command({ type: 'speech-start', id: 'reply' }); await f.chunk('reply')
  await vi.waitFor(() => expect(f.players[0].play).toHaveBeenCalledOnce())
  expect(f.players[0].setSinkId).toHaveBeenCalledWith('desk-speaker')
  expect(f.players[0].setSinkId.mock.invocationCallOrder[0]).toBeLessThan(f.players[0].play.mock.invocationCallOrder[0])
})
it('stops output on unplug, reports availability on replug, and never replays the interrupted reply', async () => {
  const f = renderer(); await f.command({ type: 'select-output', deviceId: 'desk-speaker' })
  await f.command({ type: 'speech-start', id: 'old' }); await f.chunk('old')
  await vi.waitFor(() => expect(f.players[0].play).toHaveBeenCalledOnce())
  f.disconnect(); await vi.waitFor(() => expect(f.players[0].pause).toHaveBeenCalledOnce())
  expect(f.send).toHaveBeenCalledWith({ type: 'output-state', deviceId: 'desk-speaker', state: 'unavailable' })
  f.reconnect(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith({ type: 'output-state', deviceId: 'desk-speaker', state: 'ready' }))
  await f.command({ type: 'speech-end', id: 'old' }); expect(f.players).toHaveLength(1)
  expect(f.getUserMedia).not.toHaveBeenCalled()
})
it.each(['unsupported', 'disconnected'])('fails closed when selected output is %s, without using the default speaker', async kind => {
  const f = renderer(kind === 'unsupported' ? { noSink: true } : { sinkError: new Error('output gone') })
  await f.command({ type: 'select-output', deviceId: 'desk-speaker' })
  await f.command({ type: 'speech-start', id: 'broken' }); await f.chunk('broken')
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith({ type: 'playback-error', id: 'broken', error: kind === 'unsupported' ? 'VOICE_OUTPUT_UNSUPPORTED' : 'output gone' }))
  expect(f.players[0].play).not.toHaveBeenCalled(); expect(f.getUserMedia).not.toHaveBeenCalled()
})
it('drops playback awaiting a sink switch if the user stops before routing completes', async () => {
  let release!: () => void
  const f = renderer({ sinkGate: new Promise<void>(resolve => { release = resolve }) })
  await f.command({ type: 'select-output', deviceId: 'desk-speaker' })
  await f.command({ type: 'speech-start', id: 'reply' }); await f.chunk('reply')
  expect(f.players[0].setSinkId).toHaveBeenCalledOnce(); expect(f.players[0].play).not.toHaveBeenCalled()
  await f.command({ type: 'stop' }); release(); await Promise.resolve(); await Promise.resolve()
  expect(f.players[0].play).not.toHaveBeenCalled(); expect(f.players[0].pause).toHaveBeenCalledOnce()
  expect(f.send.mock.calls.some(([value]) => value.type === 'error')).toBe(false)
})
it('mounts output routing separately without changing original voice-controller source', async () => {
  const listeners: Array<(event: any, data: any) => void> = []
  const controller = new DeviceVoiceController({ ipcMain: { on: (_: string, callback: any) => listeners.push(callback), removeListener: vi.fn() }, root: '/unused', request: vi.fn(), changed: vi.fn() })
  const audio = { webContents: { send: vi.fn(), mainFrame: {} }, destroy: vi.fn() }
  controller.audio = audio; controller.config = { speakerId: 'desk-speaker' }
  const event = { sender: audio.webContents, senderFrame: audio.webContents.mainFrame }
  listeners[1]!(event, { type: 'ready' })
  expect(audio.webContents.send).toHaveBeenCalledWith('pulse:voice-command', { type: 'select-output', deviceId: 'desk-speaker' })
  listeners[1]!(event, { type: 'output-devices', devices: [{ id: 'desk-speaker', label: '桌面音箱' }] })
  listeners[1]!({ ...event, senderFrame: {} }, { type: 'output-devices', devices: [] })
  expect((await controller.snapshot()).outputDevices).toEqual([{ id: 'desk-speaker', label: '桌面音箱' }])
  const request = vi.spyOn(controller, 'request')
  listeners[1]!(event, { type: 'output-state', state: 'unavailable', deviceId: 'desk-speaker' })
  expect(request).not.toHaveBeenCalled(); expect(controller.status).toContain('聊天任务继续运行'); controller.close()
})
it('changes the selected speaker without reopening capture, saving unrelated settings or cancelling tasks', async () => {
  const saved = { enabled: true, wakeEnabled: true, autoSpeak: true, name: 'Pulse', microphoneId: 'usb-mic', speakerId: 'old', asr: {}, tts: {} }
  const request = vi.fn(async () => ({ ...saved, speakerId: 'new' }))
  const controller = new DeviceVoiceController({ ipcMain: { on: vi.fn(), removeListener: vi.fn() }, root: '/unused', request, changed: vi.fn() })
  controller.config = saved; const { autoSpeak, ...captureConfig } = saved; controller.signature = JSON.stringify(captureConfig); controller.ready = true
  controller.worker = { postMessage: vi.fn(), kill: vi.fn() }
  controller.audio = { webContents: { send: vi.fn() }, destroy: vi.fn() }
  const audio = controller.audio, worker = controller.worker
  await controller.sync()
  expect(worker.kill).not.toHaveBeenCalled(); expect(audio.destroy).not.toHaveBeenCalled()
  expect(audio.webContents.send).toHaveBeenCalledWith('pulse:voice-command', { type: 'select-output', deviceId: 'new' })
  expect(request).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledWith('/api/voice/config', undefined)
  controller.close()
})
it('refreshes the device list in a short-lived audio window without creating capture or inference', async () => {
  const listeners: Array<(event: any, data: any) => void> = [], permission = vi.fn(), getUserMedia = vi.fn()
  let window: any
  class Probe {
    destroyed = false
    webContents = { mainFrame: {}, setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn((_channel: string, data: any) => {
      expect(data.type).toBe('enumerate-devices')
      listeners[1]!({ sender: this.webContents, senderFrame: this.webContents.mainFrame }, { type: 'output-devices', devices: [{ id: 'speaker', label: 'Speaker' }] })
    }) }
    constructor() { window = this }
    async loadFile() { listeners[1]!({ sender: this.webContents, senderFrame: this.webContents.mainFrame }, { type: 'ready' }) }
    isDestroyed() { return this.destroyed }; destroy() { this.destroyed = true }
  }
  const controller = new DeviceVoiceController({ BrowserWindow: Probe, session: { fromPartition: () => ({ setPermissionRequestHandler: permission, setPermissionCheckHandler: vi.fn() }) }, ipcMain: { on: (_: string, listener: any) => listeners.push(listener), removeListener: vi.fn() }, root: '/unused', request: vi.fn(), changed: vi.fn() })
  expect((await controller.action('list-devices')).outputDevices).toEqual([{ id: 'speaker', label: 'Speaker' }])
  expect(controller.worker).toBeUndefined(); expect(controller.audio).toBeUndefined(); expect(window.destroyed).toBe(true); expect(getUserMedia).not.toHaveBeenCalled()
  const callback = vi.fn(); permission.mock.calls[0]![0]({}, 'media', callback); expect(callback).toHaveBeenCalledWith(false)
  controller.close()
})
it.each(['played', 'cancelled', 'unavailable'])('previews in the audio partition without capture and cleans up when %s', async outcome => {
  const listeners: Array<(event: any, data: any) => void> = [], windows: any[] = []
  class Preview {
    destroyed = false
    webContents = { mainFrame: {}, setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn((_channel: string, _value: any) => {}) }
    constructor() { windows.push(this) }
    async loadFile() { emit(this, { type: 'ready' }) }
    isDestroyed() { return this.destroyed }; destroy() { this.destroyed = true }
  }
  const emit = (window: any, data: any) => listeners[1]!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, data)
  const partition = vi.fn(() => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }))
  const controller = new DeviceVoiceController({ BrowserWindow: Preview, session: { fromPartition: partition }, ipcMain: { on: (_: string, listener: any) => listeners.push(listener), removeListener: vi.fn() }, root: '/unused', request: vi.fn(async () => ({ speakerId: 'saved-audio-origin-id' })), changed: vi.fn() })
  const preview = controller.action('preview-output', { audio: 'AAA=', mime: 'audio/wav' })
  // Install rejection handling before simulating disconnect/cancel.
  const result = preview.then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(windows).toHaveLength(1))
  expect(partition).toHaveBeenCalledWith('pulse-voice')
  expect(windows[0].webContents.send).toHaveBeenCalledWith('pulse:voice-command', { type: 'select-output', deviceId: 'saved-audio-origin-id' })
  if (outcome === 'unavailable') emit(windows[0], { type: 'output-state', state: 'unavailable' })
  else {
    emit(windows[0], { type: 'output-state', state: 'ready' })
    expect(windows[0].webContents.send).toHaveBeenCalledWith('pulse:voice-command', { type: 'play', audio: 'AAA=', mime: 'audio/wav' })
    if (outcome === 'played') emit(windows[0], { type: 'played' })
    else await controller.action('preview-stop')
  }
  const completed = await result
  if (outcome === 'played') expect(completed).toEqual({ value: { ok: true } })
  else expect(completed).toHaveProperty('error')
  expect(windows[0].destroyed).toBe(true); expect(controller.audio).toBeUndefined(); expect(controller.worker).toBeUndefined(); controller.close()
})
it('does not leak a preview window if saved configuration fails or stop wins during loading', async () => {
  const create = vi.fn(), request = vi.fn().mockRejectedValueOnce(new Error('settings unavailable'))
  const controller = new DeviceVoiceController({ BrowserWindow: create, ipcMain: { on: vi.fn(), removeListener: vi.fn() }, root: '/unused', request, changed: vi.fn() })
  await expect(controller.action('preview-output', { audio: 'AAA=', mime: 'audio/wav' })).rejects.toThrow('settings unavailable')
  let resolve!: (value: unknown) => void; request.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const preview = controller.action('preview-output', { audio: 'AAA=', mime: 'audio/wav' })
  await controller.action('preview-stop'); resolve({ speakerId: 'saved' })
  await expect(preview).rejects.toThrow('CANCELLED'); expect(create).not.toHaveBeenCalled(); controller.close()
})
