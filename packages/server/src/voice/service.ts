import { z } from 'zod'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProviderCredentialStore } from '../providers/credentials.js'

const connection = z.object({ backend: z.enum(['local', 'external']).optional(), baseURL: z.string().url().default('http://127.0.0.1:8000/v1'), model: z.string().max(200).default(''), credentialRef: z.string().regex(/^credential-[a-f0-9-]{36}$/).optional(), voice: z.string().max(200).default('af_heart'), language: z.string().max(20).default(''), speed: z.number().min(0.25).max(4).default(1) }).strict()
export const voiceConfigSchema = z.object({ enabled: z.boolean().default(false), wakeEnabled: z.boolean().default(false), autoSpeak: z.boolean().default(true), name: z.string().trim().min(2).max(30).default('Pulse'), microphoneId: z.string().max(500).default(''), speakerId: z.string().max(500).default(''), followupSeconds: z.number().int().min(5).max(120).default(30), speakerThreshold: z.number().min(0.1).max(0.95).default(0.6), wakeThreshold: z.number().min(0.05).max(0.95).default(0.25), asr: connection.default({}), tts: connection.default({}) }).strict()
export type VoiceConfig = z.infer<typeof voiceConfigSchema>
export class VoiceService {
  private tail: Promise<unknown> = Promise.resolve()
  readonly credentials: ProviderCredentialStore
  readonly directory: string
  constructor(dataDir: string) { this.directory = join(dataDir, 'voice'); this.credentials = new ProviderCredentialStore(join(this.directory, 'config.json')) }
  async config(): Promise<VoiceConfig> {
    try { return voiceConfigSchema.parse(JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return voiceConfigSchema.parse({}); throw error }
  }
  save(input: unknown): Promise<VoiceConfig> {
    const work = this.tail.catch(() => undefined).then(async () => {
      const { asrKey, ttsKey, ...raw } = z.object({ asrKey: z.string().max(16384).nullable().optional(), ttsKey: z.string().max(16384).nullable().optional() }).passthrough().parse(input)
      const config = voiceConfigSchema.parse(raw)
      for (const [kind, key] of [['asr', asrKey], ['tts', ttsKey]] as const) {
        if (key === null) delete config[kind].credentialRef
        else if (typeof key === 'string' && key.trim()) config[kind].credentialRef = await this.credentials.add(key.trim())
      }
      for (const kind of ['asr', 'tts'] as const) this.endpoint(config[kind].baseURL, '')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temp = join(this.directory, `${randomUUID()}.tmp`)
      await writeFile(temp, JSON.stringify(config), { mode: 0o600 }); await rename(temp, join(this.directory, 'config.json'))
      return config
    })
    this.tail = work; return work
  }
  /** Select a bundled model without replacing other settings edited by another request. */
  useLocal(kind: 'asr' | 'tts'): Promise<VoiceConfig['asr']> {
    const work = this.tail.catch(() => undefined).then(async () => {
      const config = await this.config()
      config[kind] = { ...config[kind], backend: 'local', model: kind === 'asr' ? 'pulse-sensevoice-small' : 'pulse-kokoro-zh-en', ...(kind === 'tts' && config.tts.backend !== 'local' ? { voice: '45' } : {}) }
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temp = join(this.directory, `${randomUUID()}.tmp`)
      await writeFile(temp, JSON.stringify(config), { mode: 0o600 }); await rename(temp, join(this.directory, 'config.json'))
      return config[kind]
    })
    this.tail = work; return work
  }
  private endpoint(base: string, path: string): URL {
    const url = new URL(base.replace(/\/$/, '') + path)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('VOICE_SERVICE_URL_INVALID')
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('VOICE_REMOTE_SERVICE_REQUIRES_HTTPS')
    return url
  }
  private async request(kind: 'asr' | 'tts', path: string, body?: BodyInit, json = false): Promise<Response> {
    const config = (await this.config())[kind]
    if (config.backend === 'local') throw new Error('VOICE_DESKTOP_REQUIRED')
    const key = config.credentialRef ? await this.credentials.get(config.credentialRef) : undefined
    const result = await fetch(this.endpoint(config.baseURL, path), { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(60000), headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}) })
    if (!result.ok) { await result.body?.cancel(); throw new Error(`VOICE_${kind.toUpperCase()}_HTTP_${result.status}`) }
    return result
  }
  async test(kind: 'asr' | 'tts'): Promise<unknown> { const response = await this.request(kind, '/models'); const data = await response.json() as { data?: Array<{ id?: string }> }; return { ok: true, models: data.data?.slice(0, 200).map(model => model.id) ?? [] } }
  async transcribe(audio: string): Promise<{ text: string }> {
    if (audio.length > 3_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) throw new Error('VOICE_AUDIO_INVALID')
    const bytes = Buffer.from(audio, 'base64')
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('VOICE_WAV_REQUIRED')
    const config = await this.config(); if (!config.asr.model) throw new Error('VOICE_ASR_MODEL_REQUIRED')
    const body = new FormData(); body.set('model', config.asr.model); body.set('file', new Blob([bytes], { type: 'audio/wav' }), 'speech.wav'); if (config.asr.language && config.asr.language !== 'auto') body.set('language', config.asr.language === 'zh-Hant' ? 'zh' : config.asr.language)
    const response = await this.request('asr', '/audio/transcriptions', body)
    const result = await response.json() as { text?: string }
    if (typeof result.text !== 'string' || result.text.length > 20000) throw new Error('VOICE_TRANSCRIPT_INVALID')
    return { text: result.text.trim() }
  }
  async speech(text: string): Promise<{ audio: string; mime: string }> {
    if (!text.trim() || text.length > 12000) throw new Error('VOICE_TEXT_INVALID')
    const config = await this.config(); if (!config.tts.model) throw new Error('VOICE_TTS_MODEL_REQUIRED')
    const response = await this.request('tts', '/audio/speech', JSON.stringify({ model: config.tts.model, voice: config.tts.voice, speed: config.tts.speed, input: text, response_format: 'wav' }), true)
    const chunks: Uint8Array[] = []; let size = 0
    if (!response.body) throw new Error('VOICE_AUDIO_EMPTY')
    for await (const chunk of response.body as any) { size += chunk.length; if (size > 25_000_000) throw new Error('VOICE_AUDIO_TOO_LARGE'); chunks.push(chunk) }
    if (!size) throw new Error('VOICE_AUDIO_EMPTY')
    const bytes = Buffer.concat(chunks)
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('VOICE_TTS_WAV_REQUIRED')
    return { audio: bytes.toString('base64'), mime: 'audio/wav' }
  }
}
