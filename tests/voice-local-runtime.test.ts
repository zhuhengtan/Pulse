import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalSpeech } from '../packages/desktop/src/voice/local-speech.mjs'
import { asrLanguage, transcriptText, pcmWave, readPcmWave } from '../packages/desktop/src/voice/local-engine.mjs'
const managers: LocalSpeech[] = [], roots: string[] = []
it('uses Chinese for blank local language, preserves explicit auto and converts writing without guessing words', () => {
 expect(asrLanguage()).toBe('zh'); expect(asrLanguage('  ')).toBe('zh'); expect(asrLanguage('auto')).toBe('auto')
 expect(() => asrLanguage('invented')).toThrow('VOICE_LOCAL_LANGUAGE_INVALID')
 expect(transcriptText('來姨媽能吃柚子嗎？', 'zh')).toBe('来姨妈能吃柚子吗？')
 expect(transcriptText('来姨妈能吃柚子吗？', 'zh-Hant')).toBe('來姨媽能吃柚子嗎？')
 expect(transcriptText('來一媽能吃又的嗎？ようず', 'zh')).toBe('来一妈能吃又的吗？ようず')
 expect(transcriptText('來姨媽。ようず Hello', 'auto')).toBe('來姨媽。ようず Hello')
})
it('reports an installed Whisper as available for an explicit upgrade', async () => {
 const { manager, children } = fixture(false), starting = manager.start()
 children[0].emit('message', { type: 'ready', ready: { asr: true, tts: false }, legacyAsr: true })
 await starting
 expect(manager.snapshot().asr).toMatchObject({ ready: true, installing: false, upgradeAvailable: true })
})
afterEach(async () => { managers.splice(0).forEach(manager => manager.close()); vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function fixture(autoReady = true) {
  const children: any[] = []
  const forkProcess = vi.fn(() => {
    const child: any = new EventEmitter(); child.stderr = new EventEmitter(); child.connected = true
    child.kill = vi.fn(() => { child.connected = false })
    child.send = vi.fn((message, callback) => { callback?.(); if (autoReady && message.type === 'init') queueMicrotask(() => child.emit('message', { type: 'ready', ready: { asr: false, tts: false } })) })
    children.push(child); return child
  })
  const manager = new LocalSpeech({ root: '/unused', node: () => process.execPath, forkProcess }); managers.push(manager)
  return { manager, children, forkProcess }
}
it('starts lazily, shares one child and rejects pending work on shutdown', async () => {
  const { manager, children, forkProcess } = fixture(); expect(forkProcess).not.toHaveBeenCalled()
  await Promise.all([manager.start(), manager.start()]); expect(forkProcess).toHaveBeenCalledOnce()
  const pending = manager.request('test', { kind: 'asr' }); const rejected = expect(pending).rejects.toThrow('PROCESS_STOPPED')
  await vi.waitFor(() => expect(manager.pending.size).toBe(1)); manager.close(); await rejected
  expect(children[0].kill).toHaveBeenCalledOnce(); await manager.start(); expect(forkProcess).toHaveBeenCalledTimes(2)
})
it('times out without replaying an unknown request and permits a fresh worker', async () => {
  const { manager, forkProcess } = fixture(); await manager.start(); vi.useFakeTimers()
  const pending = manager.request('speech', { text: 'hello' }, 100), rejected = expect(pending).rejects.toThrow('REQUEST_TIMEOUT')
  await vi.advanceTimersByTimeAsync(101); await rejected; expect(manager.child).toBeUndefined()
  vi.useRealTimers(); await manager.start(); expect(forkProcess).toHaveBeenCalledTimes(2)
})
it('does not let an old installation failure overwrite its immediate retry', async () => {
  const { manager, children } = fixture(); manager.install('asr'); manager.close(); manager.install('asr')
  await vi.waitFor(() => expect(manager.pending.size).toBe(1)); expect(manager.snapshot().asr.installing).toBe(true)
  const child = children.at(-1), request = child.send.mock.calls.map(call => call[0]).find(message => message.method === 'install')
  child.emit('message', { type: 'result', id: request.id, result: { ready: true } })
  await vi.waitFor(() => expect(manager.snapshot().asr).toMatchObject({ ready: true, installing: false, error: undefined }))
})
it('reports missing models through a real isolated IPC worker and can restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-local-worker-')); roots.push(root)
  const manager = new LocalSpeech({ root, node: () => process.execPath }); managers.push(manager)
  await expect(manager.request('test', { kind: 'asr' })).rejects.toThrow('MODEL_NOT_INSTALLED')
  expect(manager.snapshot().asr.ready).toBe(false); manager.close()
  await expect(manager.request('test', { kind: 'tts' })).rejects.toThrow('MODEL_NOT_INSTALLED')
})
it('roundtrips PCM at native TTS rates and rejects invalid recordings before native inference', () => {
  const wave = readPcmWave(pcmWave(Float32Array.from([0, -1, 0.5, 1]), 24000))
  expect(wave.sampleRate).toBe(24000); expect(wave.samples[1]).toBeCloseTo(-1, 3)
  expect(() => readPcmWave('invalid')).toThrow('WAV_REQUIRED')
  expect(() => readPcmWave(pcmWave(new Float32Array(0), 16000))).toThrow('PCM_MONO_REQUIRED')
  expect(() => readPcmWave(pcmWave(new Float32Array(16000 * 31), 16000))).toThrow('PCM_MONO_REQUIRED')
  const malformed = Buffer.from(pcmWave(new Float32Array(10), 16000), 'base64'); malformed.writeUInt32LE(999999, 40)
  expect(() => readPcmWave(malformed.toString('base64'))).toThrow('AUDIO_INVALID')
})

it('cancels an unfinished startup immediately and keeps byte progress during native loading', async () => {
  const { manager, children } = fixture(false)
  const starting = manager.start(), rejected = expect(starting).rejects.toThrow('PROCESS_STOPPED')
  manager.close(); await rejected
  expect(children[0].kill).toHaveBeenCalledOnce()
  const retried = manager.start(), child = children.at(-1)
  child.emit('message', { type: 'ready', ready: { asr: true, tts: false } }); await retried
  child.emit('message', { type: 'progress', kind: 'asr', stage: '解压', received: 100, total: 100 })
  child.emit('message', { type: 'progress', kind: 'asr', stage: '正在加载本地模型' })
  expect(manager.snapshot().asr).toMatchObject({ received: 100, total: 100, stage: '正在加载本地模型' })
})
it('does not carry a request across a close and immediate process restart', async () => {
  const { manager, children } = fixture(); await manager.start()
  const pending = manager.request('speech', { text: 'must not replay' }), rejected = expect(pending).rejects.toThrow('PROCESS_STOPPED')
  manager.close(); await manager.start(); await rejected
  expect(children.at(-1).send.mock.calls.some(call => call[0].method === 'speech')).toBe(false)
})
