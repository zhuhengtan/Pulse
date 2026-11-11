import type { PulseWebTransport } from '../../src/transport.js'

export const voiceConfig = { enabled: false, wakeEnabled: false, autoSpeak: true, name: 'Pulse', microphoneId: '', followupSeconds: 30, speakerThreshold: 0.6, wakeThreshold: 0.25, asr: { baseURL: 'http://127.0.0.1:8000/v1', model: 'whisper', credentialRef: 'credential-11111111-1111-1111-1111-111111111111' }, tts: { baseURL: 'http://127.0.0.1:8000/v1', model: 'kokoro', voice: 'af_heart', credentialRef: 'credential-22222222-2222-2222-2222-222222222222' } }
type LocalState = { ready: boolean; installing: boolean; error?: string; received?: number; total?: number; stage?: string; upgradeAvailable?: boolean }
export function voiceFixture({ enabled = false, failSave = false, desktopReady = false, localReady = false, compactTts = false, legacyAsr = false, legacyBackend = false, installRequestError = '', installOutcome = 'ready' as 'ready' | 'installing' | 'error' } = {}) {
  let config = { ...structuredClone(voiceConfig), enabled } as Omit<typeof voiceConfig, 'autoSpeak' | 'wakeEnabled'> & { autoSpeak?: boolean; wakeEnabled?: boolean; asr: { backend?: string }; tts: { backend?: string } }
  if (compactTts) config.tts = { ...config.tts, backend: 'local', model: 'pulse-kokoro-zh-en', voice: '50' }
  if (legacyAsr) config.asr = { ...config.asr, backend: 'local', model: 'pulse-whisper-base' }
  if (legacyBackend) { delete config.autoSpeak; delete config.wakeEnabled }
  const localSpeech = { asr: { ready: localReady || legacyAsr, installing: false, upgradeAvailable: legacyAsr } as LocalState, tts: { ready: localReady || compactTts, installing: false, upgradeAvailable: compactTts } as LocalState, voices: [{ id: '45', name: '晓北 · 中文女声' }, { id: '50', name: '云希 · 中文男声' }], models: { asr: 'SenseVoice Small', tts: 'Kokoro' } }
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  let ready = desktopReady, paused = false
  const snapshot = () => ({ localSpeech, wakeEnabled: config.wakeEnabled, status: config.enabled ? !(config.wakeEnabled ?? legacyBackend) ? '仅按住说话，麦克风未占用' : paused ? '已暂停' : ready ? '请先录入主人声纹' : '请先下载唤醒与声纹模型' : '已关闭', running: config.enabled && (config.wakeEnabled ?? legacyBackend) && ready && !paused, modelsReady: ready, enrolled: false, paused, devices: [{ id: 'fixture-mic', label: '测试麦克风' }] })
  const transport: PulseWebTransport = { request: async (path, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, ...(body ? { body } : {}) })
    if (path === '/api/voice/config') {
      if (body) {
        if (failSave) return Response.json({ error: 'SAVE_FAILED' }, { status: 400 })
        const { asrKey, ttsKey, ...value } = body
        config = value
        if (asrKey === null) delete config.asr.credentialRef
        if (ttsKey === null) delete config.tts.credentialRef
      }
      return Response.json(config)
    }
    if (path === '/api/voice/test') return Response.json({ models: ['whisper', 'kokoro'] })
    if (path === '/api/voice/speech') return Response.json({ audio: '', mime: 'audio/wav' })
    if (path.startsWith('/api/desktop/voice/')) {
      if (path.endsWith('/wake-settings')) config.wakeEnabled = body.enabled
      if (path.endsWith('/pause')) paused = true
      if (path.endsWith('/resume')) paused = false
      if (path.endsWith('/models')) ready = true
      if (path.endsWith('/install-asr') || path.endsWith('/install-tts')) {
        if (installRequestError) return Response.json({ error: installRequestError }, { status: 400 })
        const kind = path.endsWith('/install-asr') ? 'asr' : 'tts'
        config[kind] = { ...config[kind], backend: 'local', model: kind === 'asr' ? 'pulse-sensevoice-small' : 'pulse-kokoro-zh-en', ...(kind === 'tts' && config.tts.backend !== 'local' ? { voice: '45' } : {}) }
        localSpeech[kind] = installOutcome === 'installing' ? { ready: false, installing: true, received: 50, total: 100, stage: '正在下载' } : installOutcome === 'error' ? { ready: false, installing: false, error: 'VOICE_MODEL_DOWNLOAD_FAILED' } : { ready: true, installing: false }
        installOutcome = 'ready'
        return Response.json({ ...snapshot(), connection: config[kind] })
      }
      return Response.json(snapshot())
    }
    return Response.json({ error: 'UNKNOWN_FIXTURE_PATH' }, { status: 404 })
  }, subscribe: () => () => {} }
  return { transport, calls }
}
