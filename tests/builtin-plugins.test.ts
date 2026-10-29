import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
const { WebSocketServer } = createRequire(new URL('../packages/server/package.json', import.meta.url))('ws')
import { createLocalHost, H5Server, type LocalHostOptions } from '../packages/server/src/index.js'
import { parseBuiltinPlugins, pluginDraft, resolveConnection, type MediaKind, type PluginHostConfig } from '../packages/server/src/builtin-plugins/config.js'
import { BuiltinPluginJobs } from '../packages/server/src/builtin-plugins/jobs.js'
import { PluginToolRegistry, registerPluginTools, refreshPluginProjection } from '../packages/server/src/builtin-plugins/tools.js'
import { startGeneration, pollGeneration, cancelGeneration } from '../packages/server/src/builtin-plugins/adapters.js'
import { materialize, pluginNetworkGate, wav } from '../packages/server/src/builtin-plugins/http.js'
import { ProviderCredentialStore } from '../packages/server/src/providers/credentials.js'
import { normalizeDiscoveredModel } from '../packages/server/src/providers/onboarding.js'
import { sanitizeWorkspaceConfig } from '../packages/cli/src/config.js'
import { startH5WorkWorker } from '../packages/server/src/h5/work-worker.js'
import { fileURLToPath } from 'node:url'

const previousHome = process.env.PULSE_HOME, previousConfig = process.env.PULSE_CONFIG
const isolatedHome = mkdtempSync(join(tmpdir(), 'pulse-plugin-home-'))
process.env.PULSE_HOME = isolatedHome
process.env.PULSE_CONFIG = ''
afterAll(() => {
  if (previousHome === undefined) delete process.env.PULSE_HOME
  else process.env.PULSE_HOME = previousHome
  if (previousConfig === undefined) delete process.env.PULSE_CONFIG
  else process.env.PULSE_CONFIG = previousConfig
  rmSync(isolatedHome, { recursive: true, force: true })
})
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const audio = wav(Buffer.alloc(2400))
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of closers.splice(0).reverse()) await close() })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'pulse-plugins-')); closers.push(() => rm(root, { recursive: true, force: true })); return root }
async function http(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  closers.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) }))
  return 'http://127.0.0.1:' + (server.address() as any).port
}
const json = (res: ServerResponse, data: unknown, code = 200) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data))
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()) }
function config(baseURL: string): PluginHostConfig { return { allowNetwork: true, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL, model: 'fixture' } }, audio_gen: { enabled: true, modes: { speech: { source: 'standalone', adapter: 'custom', baseURL, model: 'speech' }, music: { source: 'standalone', adapter: 'custom', baseURL, model: 'music' }, sound: { source: 'standalone', adapter: 'custom', baseURL, model: 'sound' } } } } } }
const signal = () => new AbortController().signal
async function manager(c: PluginHostConfig) { const root = await directory(), path = join(root, 'config.json'); await writeFile(path, JSON.stringify(c)); return { root, path, jobs: new BuiltinPluginJobs(root, () => c, () => path) } }
const mock = { provider: { provider: 'mock' as const, defaultModel: 'fixture' }, providerProfiles: { fixture: { provider: 'mock' as const, defaultModel: 'fixture' } }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', activeProviderCode: 'fixture' }
async function settings(c: PluginHostConfig, launch?: { networkOverride?: boolean }) {
  const root = await directory(), path = join(root, 'config.json'), dataDir = join(root, 'data')
  await writeFile(path, JSON.stringify(c))
  const prepare = async (file: string): Promise<LocalHostOptions> => {
    const raw = JSON.parse(await readFile(file, 'utf8')); parseBuiltinPlugins(raw.builtinPlugins, raw)
    return { ...mock, cwd: root, dataDir, taskController: false, allowNetwork: raw.allowNetwork, builtinPluginConfigPath: file, builtinPluginConfig: raw, approvalMode: 'ask' }
  }
  const initial = await prepare(path)
  const host = createLocalHost(launch?.networkOverride === undefined ? initial : { ...initial, allowNetwork: launch.networkOverride, builtinPluginNetworkOverride: launch.networkOverride }); await host.init()
  const server = new H5Server(host, { host: '127.0.0.1', port: 0, dataDir, configuration: { path, prepare } })
  closers.push(async () => { await server.stop(); await host.close() })
  const base = 'http://127.0.0.1:' + (await server.start()).port
  const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const headers = { Origin: base, Cookie: session.headers.get('set-cookie')!.split(';')[0]!, 'Content-Type': 'application/json' }
  const envelope = () => fetch(base + '/api/config', { headers }).then(r => r.json())
  return { root, path, dataDir, host, base, headers, envelope }
}

describe('builtin plugin configuration and catalog', () => {
  it('strips transient tokens, enforces capabilities, references and host ownership', () => {
    const c = config('http://localhost:9999')
    ;(c.builtinPlugins!.image_gen!.connection as any).token = 'draft-only'
    const draft = pluginDraft(c.builtinPlugins)
    expect(JSON.stringify(draft.config)).not.toContain('draft-only'); expect(draft.tokens.get('image')).toBe('draft-only')
    expect(parseBuiltinPlugins(draft.config)).toBeTruthy()
    expect(() => parseBuiltinPlugins({ image_gen: { enabled: true } })).toThrow('PLUGIN_CONNECTION_REQUIRED')
    expect(() => parseBuiltinPlugins({ video_gen: { enabled: true, connection: { source: 'standalone', adapter: 'elevenlabs', baseURL: 'http://localhost', model: 'x' } } })).toThrow('PLUGIN_CAPABILITY_UNSUPPORTED')
    expect((sanitizeWorkspaceConfig(c as any) as any).builtinPlugins).toBeUndefined()
  })
  it('reuses media model credentials without using chat capabilities or coding-plan keys', async () => {
    const root = await directory(), path = join(root, 'config.json'), store = new ProviderCredentialStore(path), ref = await store.add('fixture-secret')
    const c: PluginHostConfig = { providers: { g: { provider: 'gemini', presetId: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', credentialRef: ref, models: { image: { modelCode: 'fixture-image', purposes: ['image'] }, vision: { modelCode: 'chat', imageInput: 'supported' } } } }, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'model', adapter: 'google', modelRef: 'g/image' } } } }
    expect(await resolveConnection(c, 'image', path)).toMatchObject({ baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'fixture-secret', credentialRef: ref, model: 'fixture-image' })
    c.providers.g.baseURL = 'http://127.0.0.1:8800/proxy'
    c.builtinPlugins!.image_gen!.connection!.baseURL = ''
    expect(await resolveConnection(c, 'image', path)).toMatchObject({ baseURL: 'http://127.0.0.1:8800/proxy' })
    c.builtinPlugins!.image_gen!.connection!.modelRef = 'g/vision'
    expect(() => parseBuiltinPlugins(c.builtinPlugins, c)).toThrow('PLUGIN_MODEL_PURPOSE_REQUIRED')
    c.builtinPlugins!.image_gen!.connection!.modelRef = 'g/image'; c.providers.g.connectionVariant = 'coding'
    expect(() => parseBuiltinPlugins(c.builtinPlugins, c)).toThrow('PLUGIN_BILLING_VARIANT_UNSUPPORTED')
  })
  it('imports generation purposes and keeps transcription out of generation', () => {
    expect(normalizeDiscoveredModel({ id: 'picture', output_modalities: ['image'] })).toMatchObject({ purposes: ['image'], tools: 'unsupported' })
    expect(normalizeDiscoveredModel({ id: 'voice', type: 'speech-to-text' })).toBeUndefined()
    expect(normalizeDiscoveredModel({ id: 'gpt-image-fixture' })).toMatchObject({ purposes: ['image'] })
  })
  it('filters old catalogs and actual provider projections immediately after disable', async () => {
    const { jobs, path, root } = await manager(config('http://localhost'))
    const registry = new PluginToolRegistry({}, jobs); registerPluginTools(registry, jobs, root, 'run', path)
    expect(registry.discover().some(t => t.manifest.name === 'image.generate')).toBe(true)
    const old = registry.list().map(m => ({ name: m.name, description: m.description, inputSchema: m.inputSchema }))
    const c = config('http://localhost'); c.builtinPlugins!.image_gen!.enabled = false; await writeFile(path, JSON.stringify(c))
    expect(registry.list().some(t => t.name === 'image.generate')).toBe(false)
    expect(() => registry.validateInput('image.generate', { prompt: 'test' })).toThrow('TOOL_NOT_ALLOWED')
    const effect = { input: { request: { blocks: [{ kind: 'tools', content: { tools: old } }] } } } as any
    expect(JSON.stringify(refreshPluginProjection(effect, registry))).not.toContain('"name":"image.generate"')
    const validator = registry.inputValidator()
    expect(() => validator('image.generate', { prompt: 'test' })).not.toThrow()
    c.builtinPlugins!.image_gen!.enabled = true; await writeFile(path, JSON.stringify(c))
    expect(registry.get('image.generate')).toBeTruthy()
    expect(() => validator('image.generate', { prompt: 'test' })).not.toThrow()
  })
})

describe('generation lifecycle over real local HTTP', () => {
  it.each(['image', 'speech', 'music', 'sound'] as MediaKind[])('saves %s as a hashed artifact without persisting credentials', async kind => {
    let received: any
    const url = await http(async (req, res) => { received = await body(req); json(res, { status: 'succeeded', outputs: [{ mediaType: kind === 'image' ? 'image/png' : 'audio/wav', dataBase64: (kind === 'image' ? png : audio).toString('base64') }] }) })
    const { root, jobs } = await manager(config(url))
    const output = await jobs.generate(root, 'run', kind, kind, { prompt: 'test' }, signal(), () => {})
    expect(received).toMatchObject({ kind, prompt: 'test' }); expect(output.hash).toHaveLength(64)
    expect(await readFile(join(root, output.path))).toEqual(kind === 'image' ? png : audio)
    expect(JSON.stringify(await jobs.list())).not.toContain('apiKey')
    expect(await jobs.generate(root, 'run', kind, kind, { prompt: 'test' }, signal(), () => {})).toEqual(output)
  })
  it('polls one remote task, preserves its snapshot, and uses new settings on the next call', async () => {
    let posts = 0, polls = 0
    const url = await http(async (req, res) => {
      if (req.method === 'POST') { posts++; json(res, { status: 'queued', id: 'fixture-id' }) }
      else { polls++; json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] }) }
    })
    const { root, jobs, path } = await manager(config(url))
    const pending = jobs.generate(root, 'run', 'effect', 'image', { prompt: 'test' }, signal(), () => {})
    while (!(await jobs.list()).some(j => j.ticket)) await new Promise(r => setTimeout(r, 10))
    const next = config('http://127.0.0.1:1'); next.builtinPlugins!.image_gen!.enabled = false
    await jobs.lock(async () => { expect(await jobs.disabling(config(url), next, { image_gen: 'finish' })).toEqual([]); await writeFile(path, JSON.stringify(next)) })
    expect((await pending).mediaType).toBe('image/png'); expect(posts).toBe(1); expect(polls).toBe(1)
    await expect(jobs.generate(root, 'run', 'later', 'image', { prompt: 'test' }, signal(), () => {})).rejects.toThrow('PLUGIN_DISABLED')
  })
  it('requires a disable decision and cancels only this remote task across manager instances', async () => {
    let cancelled = false
    const url = await http((req, res) => { if (req.method === 'DELETE') { cancelled = true; json(res, {}) } else json(res, { status: 'running', id: 'cancel-this' }) })
    const previous = config(url), { root, jobs, path } = await manager(previous)
    const pending = jobs.generate(root, 'run', 'effect', 'image', { prompt: 'test' }, signal(), () => {}).catch(e => e.message)
    while (!(await jobs.list()).some(j => j.ticket)) await new Promise(r => setTimeout(r, 10))
    const next = config(url); next.builtinPlugins!.image_gen!.enabled = false
    const other = new BuiltinPluginJobs(root, () => previous, () => path)
    await expect(other.disabling(previous, next)).rejects.toThrow('PLUGIN_ACTIVE_JOBS')
    await other.lock(async () => { const stop = await other.disabling(previous, next, { image_gen: 'cancel' }); await writeFile(path, JSON.stringify(next)); await other.cancel(stop) })
    expect(await pending).toBe('PLUGIN_CANCELLED'); expect(cancelled).toBe(true)
    expect((await jobs.list())[0]).toMatchObject({ state: 'cancelled', remoteCancellation: 'requested' })
  })
  it('bounds timeout, reports authentication and malformed results, and never follows redirects', async () => {
    const service = await http((_req, res) => json(res, {}, 401)), { jobs, root } = await manager(config(service))
    await expect(jobs.generate(root, 'run', 'auth', 'image', { prompt: 'test' }, signal(), () => {})).rejects.toThrow('PLUGIN_AUTH_FAILED')
    expect((await jobs.list())[0]?.state).toBe('failed')
    const malformed = await http((_req, res) => json(res, { status: 'succeeded', outputs: [] }))
    const c = { source: 'standalone' as const, adapter: 'custom' as const, model: 'x', baseURL: malformed }
    await expect(startGeneration(c, 'image', { prompt: 'test' }, [], signal())).rejects.toThrow('PLUGIN_PROTOCOL_ERROR')
    const redirect = await http((_req, res) => res.writeHead(302, { location: service }).end())
    await expect(startGeneration({ ...c, baseURL: redirect }, 'image', { prompt: 'test' }, [], signal())).rejects.toThrow('PLUGIN_REDIRECT_BLOCKED')
    const slow = await http(() => {}), cfg = config(slow); cfg.builtinPlugins!.image_gen!.connection!.timeoutMs = 100
    const timed = await manager(cfg)
    await expect(timed.jobs.generate(timed.root, 'run', 'timeout', 'image', { prompt: 'test' }, signal(), () => {})).rejects.toThrow('PLUGIN_TIMEOUT')
    await expect(materialize(c, { bytes: Buffer.from('<script>bad</script>'), mediaType: 'image/png' }, signal())).rejects.toThrow('PLUGIN_MEDIA_TYPE_INVALID')
  })
  it('reconciles a saved task using its ID without a second submission', async () => {
    let posts = 0
    const url = await http((req, res) => { if (req.method === 'POST') posts++; json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] }) })
    const { jobs, root } = await manager(config(url)), id = jobs.id('run', 'cold')
    await mkdir(jobs.directory, { recursive: true })
    await writeFile(join(jobs.directory, id + '.json'), JSON.stringify({ id, pluginId: 'image_gen', kind: 'image', runId: 'run', root, createdAt: Date.now(), deadline: Date.now() + 10000, state: 'running', connection: { source: 'standalone', adapter: 'custom', baseURL: url, model: 'x' }, ticket: { provider: 'custom', id: 'saved' } }))
    expect((await jobs.reconcile(id, signal()))?.hash).toHaveLength(64); expect(posts).toBe(0)
  })
  it('keeps submitted credentials and uses a replacement endpoint and key on the next call', async () => {
    const seen: string[] = []
    const oldURL = await http((req, res) => {
      seen.push('old:' + req.headers.authorization)
      json(res, req.method === 'POST' ? { status: 'queued', id: 'original' } : { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] })
    })
    const newURL = await http((req, res) => { seen.push('new:' + req.headers.authorization); json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] }) })
    const { root, jobs, path } = await manager(config(oldURL)), store = new ProviderCredentialStore(path)
    const first = config(oldURL); first.builtinPlugins!.image_gen!.connection!.credentialRef = await store.add('old-synthetic')
    await writeFile(path, JSON.stringify(first))
    const pending = jobs.generate(root, 'run', 'before', 'image', { prompt: 'test' }, signal(), () => {})
    while (!(await jobs.list()).some(j => j.ticket)) await new Promise(r => setTimeout(r, 10))
    const next = config(newURL); next.builtinPlugins!.image_gen!.connection!.credentialRef = await store.add('new-synthetic')
    await writeFile(path, JSON.stringify(next))
    await pending
    await jobs.generate(root, 'run', 'after', 'image', { prompt: 'test' }, signal(), () => {})
    expect(seen).toEqual(['old:Bearer old-synthetic', 'old:Bearer old-synthetic', 'new:Bearer new-synthetic'])
  })
  it('recovers dead-process task IDs and locally stops uncertain submissions without reposting', async () => {
    let posts = 0
    const url = await http((req, res) => { if (req.method === 'POST') posts++; json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] }) })
    const { jobs, root } = await manager(config(url))
    await mkdir(jobs.directory, { recursive: true })
    const saved = { pluginId: 'image_gen', kind: 'image', runId: 'run', root, createdAt: Date.now(), deadline: Date.now() + 10000, ownerPid: 99999999, connection: { source: 'standalone', adapter: 'custom', baseURL: url, model: 'x' } }
    const known = jobs.id('run', 'known'), unknown = jobs.id('run', 'unknown')
    await writeFile(join(jobs.directory, known + '.json'), JSON.stringify({ ...saved, id: known, state: 'running', ticket: { provider: 'custom', id: 'saved' } }))
    await writeFile(join(jobs.directory, unknown + '.json'), JSON.stringify({ ...saved, id: unknown, state: 'submitting' }))
    const stop = await jobs.recoverPending()
    try {
      for (let n = 0; n < 100 && (await jobs.read(known))?.state !== 'succeeded'; n++) await new Promise(r => setTimeout(r, 10))
      expect((await jobs.read(known))?.state).toBe('succeeded')
      expect((await jobs.read(unknown))?.state).toBe('unknown')
      await expect(jobs.generate(root, 'run', 'unknown', 'image', { prompt: 'test' }, signal(), () => {})).rejects.toThrow('PLUGIN_SUBMISSION_UNKNOWN')
      expect(await jobs.cancel([(await jobs.read(unknown))!])).toEqual([])
      expect(await jobs.read(unknown)).toMatchObject({ state: 'cancelled', remoteCancellation: 'unsupported' })
      expect(posts).toBe(0)
    } finally { stop() }
  })
})

describe('native protocol contracts', () => {
  it.each(['openai', 'google', 'bailian', 'volcengine', 'minimax'] as const)('submits and polls %s video using a stable task ID', async adapter => {
    const fake = vi.spyOn(globalThis, 'fetch')
    fake.mockResolvedValueOnce(new Response(JSON.stringify(adapter === 'google' ? { name: 'operations/remote' } : adapter === 'bailian' ? { output: { task_id: 'remote' } } : { id: 'remote', task_id: 'remote' })))
    const c = { source: 'standalone' as const, adapter, baseURL: 'https://api.example/v1', model: 'fixture' }
    const created = await startGeneration(c, 'video', { prompt: 'video' }, [], signal())
    expect(created.ticket).toMatchObject({ id: 'remote', provider: adapter })
    fake.mockResolvedValueOnce(new Response(JSON.stringify(adapter === 'google' ? { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://cdn.example/video.mp4' } }] } } } : adapter === 'bailian' ? { output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example/video.mp4' } } : { status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4', url: 'https://cdn.example/video.mp4' } })))
    if (adapter === 'openai') fake.mockResolvedValueOnce(new Response(Buffer.from('0000ftypmp42')))
    expect((await pollGeneration(c, created.ticket!, 'video', signal())).asset).toBeTruthy()
    const firstURL = String(fake.mock.calls[0]![0])
    expect(firstURL).toContain(adapter === 'minimax' ? '/v2/video_generation' : adapter === 'google' ? ':predictLongRunning' : adapter === 'bailian' ? 'video-synthesis' : adapter === 'volcengine' ? '/contents/generations/tasks' : '/videos')
    if (adapter === 'bailian') expect((fake.mock.calls[0]![1]!.headers as any)['X-DashScope-Async']).toBe('enable')
  })
  it.each(['google', 'bailian', 'minimax', 'openai-compatible'] as const)('normalizes %s speech output', async adapter => {
    const fake = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(adapter === 'openai-compatible' ? audio : JSON.stringify(adapter === 'google' ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(100).toString('base64') } }] } }] } : adapter === 'bailian' ? { output: { audio: { url: 'https://cdn.example/audio.wav' } } } : { data: { audio: audio.toString('hex') } }), { headers: { 'content-type': adapter === 'openai-compatible' ? 'audio/wav' : 'application/json' } }))
    expect((await startGeneration({ source: 'standalone', adapter, baseURL: 'https://api.example/v1', model: 'fixture' }, 'speech', { prompt: 'exact text' }, [], signal())).asset).toBeTruthy()
    expect(fake).toHaveBeenCalledTimes(1)
  })
  it('uses Speech for known TTS models and Realtime only for an explicit realtime model', async () => {
    const fake = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(audio, { headers: { 'content-type': 'audio/mpeg' } }))
    await startGeneration({ source: 'standalone', adapter: 'openai', baseURL: 'https://api.example/v1', model: 'tts-1' }, 'speech', { prompt: 'exact text' }, [], signal())
    expect(String(fake.mock.calls[0]![0])).toContain('/audio/speech')
    fake.mockClear()
    await startGeneration({ source: 'standalone', adapter: 'openai', baseURL: 'https://api.example/v1', model: 'gpt-realtime-2.1-mini', speechTransport: 'speech' }, 'speech', { prompt: 'exact text' }, [], signal())
    expect(String(fake.mock.calls[0]![0])).toContain('/audio/speech')
    expect(fake).toHaveBeenCalledTimes(1)
    await expect(startGeneration({ source: 'standalone', adapter: 'openai', baseURL: 'https://api.example/v1', model: 'unknown-voice' }, 'speech', { prompt: 'exact text' }, [], signal())).rejects.toThrow('PLUGIN_SPEECH_CHANNEL_REQUIRED')
    expect(fake).toHaveBeenCalledTimes(1)
  })
  it('accepts an empty 204 cancel and still reports authentication failure', async () => {
    const fake = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }))
    const connection = { source: 'standalone' as const, adapter: 'custom' as const, baseURL: 'http://127.0.0.1:9', model: 'fixture' }
    expect(await cancelGeneration(connection, { provider: 'custom', id: 'job' }, signal())).toBe(true)
    expect(fake.mock.calls[0]![1]!.method).toBe('DELETE')
    fake.mockResolvedValueOnce(new Response('no', { status: 401 }))
    await expect(cancelGeneration(connection, { provider: 'custom', id: 'job' }, signal())).rejects.toThrow('PLUGIN_AUTH_FAILED')
  })
  it('collects real local Realtime audio frames into a WAV artifact', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening'); closers.push(() => new Promise<void>(r => { for (const client of server.clients) client.terminate(); server.close(() => r()) }))
    let messages = 0
    server.on('connection', client => client.on('message', data => {
      const body = JSON.parse(data.toString()); messages++
      if (body.type === 'response.create') {
        client.send(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.alloc(200).toString('base64') }))
        client.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
      }
    }))
    const output = await startGeneration({ source: 'standalone', adapter: 'openai', baseURL: 'http://127.0.0.1:' + (server.address() as any).port, model: 'fixture-realtime' }, 'speech', { prompt: 'hello' }, [], signal())
    expect(output.asset?.bytes?.toString('ascii', 8, 12)).toBe('WAVE'); expect(messages).toBe(3)
  })
  it('runs the ComfyUI prompt/history protocol with configured nodes only', async () => {
    const fake = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"prompt_id":"mine"}')).mockResolvedValueOnce(new Response('{"mine":{"status":{"completed":true},"outputs":{"9":{"images":[{"filename":"result.png","subfolder":"","type":"output"}]}}}}'))
    const c = { source: 'standalone' as const, adapter: 'comfyui' as const, baseURL: 'http://localhost:8188', model: 'checkpoint', workflow: { '6': { inputs: { text: '' } }, '9': { inputs: {} } }, mappings: { prompt: { node: '6', input: 'text' }, outputNode: '9' } }
    const result = await startGeneration(c, 'image', { prompt: 'configured' }, [], signal())
    expect(JSON.parse(String(fake.mock.calls[0]![1]!.body)).prompt['6'].inputs.text).toBe('configured')
    expect((await pollGeneration(c, result.ticket!, 'image', signal())).asset?.url).toContain('/view?filename=result.png')
  })
  it.each(['openai', 'openai-compatible', 'google', 'bailian', 'volcengine', 'minimax'] as const)('uses the %s image protocol', async adapter => {
    const fake = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(adapter === 'google' ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] } : adapter === 'bailian' ? { output: { choices: [{ message: { content: [{ image: 'https://cdn.example/image.png' }] } }] } } : adapter === 'minimax' ? { data: { image_base64: [png.toString('base64')] } } : { data: [{ b64_json: png.toString('base64') }] })))
    const result = await startGeneration({ source: 'standalone', adapter, baseURL: 'https://api.example/v1', model: 'fixture', apiKey: 'synthetic' }, 'image', { prompt: 'draw' }, [], signal())
    expect(result.asset).toBeTruthy(); const call = fake.mock.calls[0]!, headers = call[1]!.headers as any
    expect(headers[adapter === 'google' ? 'x-goog-api-key' : 'authorization']).toBe(adapter === 'google' ? 'synthetic' : 'Bearer synthetic')
    expect(String(call[0])).toContain(adapter === 'google' ? ':generateContent' : adapter === 'bailian' ? 'multimodal-generation' : adapter === 'minimax' ? '/image_generation' : '/images/generations')
  })
  it.each(['speech', 'music', 'sound'] as const)('uses ElevenLabs %s routes with xi-api-key', async kind => {
    const fake = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(audio, { headers: { 'content-type': 'audio/wav' } }))
    expect((await startGeneration({ source: 'standalone', adapter: 'elevenlabs', baseURL: 'https://api.example/v1', model: 'fixture', apiKey: 'synthetic' }, kind, { prompt: 'hello', parameters: { voice: 'fixture' } }, [], signal())).asset?.bytes).toEqual(audio)
    expect((fake.mock.calls[0]![1]!.headers as any)['xi-api-key']).toBe('synthetic')
  })
  it('does not globally interrupt another ComfyUI workflow', async () => {
    const fake = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ queue_running: [[1, 'other']], queue_pending: [] })))
    expect(await cancelGeneration({ source: 'standalone', adapter: 'comfyui', baseURL: 'http://localhost:8188', model: 'x' }, { provider: 'comfyui', id: 'mine' }, signal())).toBe(false)
    expect(fake).toHaveBeenCalledTimes(1)
  })
})

describe('settings and process integration', () => {
  it('keeps draft credentials out of config/backups and serves generated media with Range', async () => {
    const url = await http((req, res) => { expect(req.headers.authorization).toBe('Bearer settings-synthetic'); json(res, { status: 'succeeded', outputs: [{ mediaType: 'audio/wav', dataBase64: audio.toString('base64') }] }) })
    const cfg = config(url), fixture = await settings(cfg)
    const initial = await fixture.envelope()
    ;(initial.config.builtinPlugins.audio_gen.modes.speech as any).token = 'settings-synthetic'
    const savedResponse = await fetch(fixture.base + '/api/config', { method: 'PUT', headers: fixture.headers, body: JSON.stringify({ version: initial.version, config: initial.config }) })
    expect(savedResponse.status).toBe(200)
    const saved = await savedResponse.json()
    expect(saved.config.builtinPlugins.audio_gen.modes.speech.credentialRef).toBeTruthy()
    expect(await readFile(fixture.path, 'utf8')).not.toContain('settings-synthetic')
    expect(await readFile(fixture.path + '.bak', 'utf8')).not.toContain('settings-synthetic')
    const output = await fixture.host.builtinPluginJobs.generate(fixture.root, 'run', 'speech', 'speech', { prompt: 'text' }, signal(), () => {})
    expect(JSON.stringify(await fixture.host.builtinPluginJobs.list())).not.toContain('settings-synthetic')
    const ranged = await fetch(fixture.base + '/api/builtin-plugins/jobs/' + output.jobId + '/artifact', { headers: { ...fixture.headers, Range: 'bytes=0-43' } })
    expect(ranged.status).toBe(206); expect(ranged.headers.get('content-type')).toBe('audio/wav'); expect((await ranged.arrayBuffer()).byteLength).toBe(44)
    const invalid = await fetch(fixture.base + '/api/builtin-plugins/jobs/' + output.jobId + '/artifact', { headers: { ...fixture.headers, Range: 'bytes=999999-' } })
    expect(invalid.status).toBe(416)
    expect((await fetch(fixture.base + '/api/config/builtin-plugins/speech/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"test"}' })).status).toBe(401)
    expect((await fetch(fixture.base + '/api/config/builtin-plugins/speech/test', { method: 'POST', headers: { ...fixture.headers, Origin: 'https://foreign.example' }, body: '{"prompt":"test"}' })).status).toBe(403)
  })
  it('requires an explicit in-flight decision at config commit and signals a real work worker', async () => {
    let cancelled = false
    const url = await http((req, res) => { if (req.method === 'DELETE') { cancelled = true; json(res, {}) } else json(res, { status: 'queued', id: 'worker-job' }) })
    const cfg = { ...config(url), providers: { fixture: { provider: 'mock', models: { fixture: { modelCode: 'fixture' } } } }, activeModel: 'fixture/fixture', taskController: false }, fixture = await settings(cfg)
    const conversation = await fixture.host.createConversation()
    const run = await startH5WorkWorker({ entry: fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)), dataDir: fixture.dataDir, configPath: fixture.path, cwd: fixture.root, approvalMode: 'ask', runtimeOptions: { ...fixture.host.getWorkWorkerOptions(), mockToolCalls: [{ name: 'image.generate', input: { prompt: 'test' } }], mockAfterToolResponse: 'stopped' } }, { conversationId: conversation.id, text: '生成图片' })
    closers.push(() => run.shutdown?.() ?? Promise.resolve())
    const events = (async () => { for await (const _event of run.events) { /* drain IPC */ } })()
    const deadline = Date.now() + 10000
    while (!(await fixture.host.builtinPluginJobs.list()).some(j => j.ticket)) { if (Date.now() > deadline) throw new Error('WORKER_DID_NOT_SUBMIT'); await new Promise(r => setTimeout(r, 20)) }
    const current = await fixture.envelope(); current.config.builtinPlugins.image_gen.enabled = false
    const input = { version: current.version, config: current.config }
    const denied = await fetch(fixture.base + '/api/config', { method: 'PUT', headers: fixture.headers, body: JSON.stringify(input) })
    expect(denied.status).toBe(409); expect(await denied.json()).toMatchObject({ error: 'PLUGIN_ACTIVE_JOBS' })
    expect(JSON.parse(await readFile(fixture.path, 'utf8')).builtinPlugins.image_gen.enabled).toBe(true)
    const stopped = await fetch(fixture.base + '/api/config', { method: 'PUT', headers: fixture.headers, body: JSON.stringify({ ...input, pluginDisableDecisions: { image_gen: 'cancel' } }) })
    expect(stopped.status).toBe(200)
    await events; await run.outcome()
    expect(cancelled).toBe(true)
    expect((await fixture.host.builtinPluginJobs.list())[0]).toMatchObject({ state: 'cancelled', remoteCancellation: 'requested' })
  }, 20000)
})

describe('network grants, host layers and credential reuse', () => {
  it('merges host layers and ignores workspace plugin endpoints', async () => {
    const root = await directory(), home = join(root, 'home'), project = join(root, 'project')
    process.env.PULSE_HOME = home
    try {
      await mkdir(home, { recursive: true })
      await mkdir(join(project, '.pulse'), { recursive: true })
      await writeFile(join(home, 'config.json'), JSON.stringify({ allowNetwork: true, providers: { openai: { provider: 'openai', baseURL: 'https://api.openai.com/v1', models: { img: { modelCode: 'gpt-image-1', purposes: ['image'] } } } }, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'model', adapter: 'openai', modelRef: 'openai/img' } }, web_search: { enabled: true } } }))
      await writeFile(join(project, '.pulse', 'config.json'), JSON.stringify({ allowNetwork: true, providers: { openai: { provider: 'openai', baseURL: 'http://workspace.invalid', apiKeyEnv: 'WORKSPACE_KEY', credentialRef: 'credential-00000000-0000-4000-8000-000000000000' } }, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://workspace.invalid', model: 'evil' } } } }))
      const explicit = join(root, 'explicit.json')
      await writeFile(explicit, JSON.stringify({ providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock' }))
      const jobs = new BuiltinPluginJobs(join(root, 'data'), () => ({ allowNetwork: false }), () => explicit)
      expect(jobs.enabled('image_gen')).toBe(true)
      expect(jobs.enabled('web_search')).toBe(true)
      expect(jobs.config().providers?.openai?.baseURL).toBe('https://api.openai.com/v1')
      expect(JSON.stringify(jobs.config())).not.toContain('workspace.invalid')
      const { loadPulseConfig } = await import('../packages/cli/src/config.js')
      const host = await loadPulseConfig(project, explicit, false, 'host')
      expect(host.value.providers?.openai?.baseURL).toBe('https://api.openai.com/v1')
      expect(JSON.stringify(host.value)).not.toContain('workspace.invalid')
    } finally { process.env.PULSE_HOME = isolatedHome }
  })
  it('reuses the provider default env key for a model reference and not for an unauthenticated local service', async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'synthetic-default'
    try {
      const root = await directory(), path = join(root, 'config.json')
      const modelConfig: PluginHostConfig = { allowNetwork: true, providers: { openai: { provider: 'openai', models: { img: { modelCode: 'gpt-image-1', purposes: ['image'] } } } }, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'model', adapter: 'custom', modelRef: 'openai/img' } } } }
      await writeFile(path, JSON.stringify(modelConfig))
      const resolved = await resolveConnection(modelConfig, 'image', path)
      expect(resolved.apiKey).toBe('synthetic-default')
      expect(resolved.credentialProvider).toBe('openai')
      expect(resolved.adapter).toBe('custom')
      const { jobs, root: workspace, path: saved } = await manager(modelConfig)
      let authorization = '', route = ''
      const url = await http((req, res) => { authorization = String(req.headers.authorization ?? ''); route = req.url ?? ''; json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] }) })
      const next = JSON.parse(await readFile(saved, 'utf8'))
      next.builtinPlugins.image_gen.connection.baseURL = url
      await writeFile(saved, JSON.stringify(next))
      await jobs.generate(workspace, 'run', 'keyed', 'image', { prompt: 'draw' }, signal(), () => {})
      expect(route).toBe('/generate')
      expect(authorization).toBe('Bearer synthetic-default')
      expect(await readFile(join(jobs.directory, jobs.id('run', 'keyed') + '.json'), 'utf8')).not.toContain('synthetic-default')
      const local = await resolveConnection({ allowNetwork: true, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: url, model: 'local' } } } }, 'image', path)
      expect(local.apiKey).toBeUndefined()
      expect(local.credentialProvider).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })
  it('keeps an explicit JSON protocol for a model reference and does not switch products', async () => {
    const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(JSON.stringify(String(input).includes('/generate') ? { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] } : { data: [{ b64_json: png.toString('base64') }] })))
    const custom = await resolveConnection({ allowNetwork: true, providers: { local: { provider: 'openai-compatible', presetId: 'custom', baseURL: 'https://compat.example/v1', models: { img: { modelCode: 'local-image', purposes: ['image'] } } } }, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'model', adapter: 'custom', modelRef: 'local/img' } } } }, 'image', join(isolatedHome, 'missing.json'))
    expect(custom.adapter).toBe('custom')
    await startGeneration(custom, 'image', { prompt: 'draw' }, [], signal())
    expect(String(fake.mock.calls[0]![0])).toContain('/generate')
    expect(String(fake.mock.calls[0]![0])).not.toContain('/images/generations')
    const recommended = await resolveConnection({ allowNetwork: true, providers: { local: { provider: 'openai-compatible', presetId: 'custom', baseURL: 'https://compat.example/v1', models: { img: { modelCode: 'local-image', purposes: ['image'] } } } }, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'model', adapter: 'openai-compatible', modelRef: 'local/img' } } } }, 'image', join(isolatedHome, 'missing.json'))
    expect(recommended.adapter).toBe('openai-compatible')
    await startGeneration(recommended, 'image', { prompt: 'draw' }, [], signal())
    expect(String(fake.mock.calls[1]![0])).toContain('/images/generations')
  })
  it('checks the grant again before a download, a Bailian submission and a Realtime socket', async () => {
    let base = '', release: (() => void) | undefined, downloads = 0, posted = false
    base = await http((req, res) => {
      if (req.method === 'POST') { posted = true; void new Promise<void>(resolve => { release = resolve }).then(() => json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', url: base + '/files/output.png' }] })); return }
      downloads += 1; res.writeHead(200, { 'content-type': 'image/png' }).end(png)
    })
    const blocked = await manager(config(base))
    const pending = blocked.jobs.generate(blocked.root, 'run', 'download', 'image', { prompt: 'draw' }, signal(), () => {})
    while (!posted) await new Promise(r => setTimeout(r, 10))
    const raw = JSON.parse(await readFile(blocked.path, 'utf8')); raw.allowNetwork = false
    await writeFile(blocked.path, JSON.stringify(raw))
    release!(); await expect(pending).rejects.toThrow('PLUGIN_NETWORK_DISABLED'); expect(downloads).toBe(0)
    const kept = await manager(config(base))
    posted = false; downloads = 0
    const continued = kept.jobs.generate(kept.root, 'run', 'kept', 'image', { prompt: 'draw' }, signal(), () => {})
    while (!posted) await new Promise(r => setTimeout(r, 10))
    const off = JSON.parse(await readFile(kept.path, 'utf8')); off.allowNetwork = false
    await writeFile(kept.path, JSON.stringify(off))
    await writeFile(join(kept.jobs.directory, kept.jobs.id('run', 'kept') + '.grant'), 'finish')
    release!(); await continued; expect(downloads).toBe(1)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const deny = () => { throw Object.assign(new Error('PLUGIN_NETWORK_DISABLED'), { code: 'PLUGIN_NETWORK_DISABLED' }) }
    await pluginNetworkGate.run(deny, async () => {
      await expect(startGeneration({ source: 'standalone', adapter: 'bailian', baseURL: 'http://127.0.0.1:9', model: 'wan' }, 'video', { prompt: 'x' }, [], signal())).rejects.toThrow('PLUGIN_NETWORK_DISABLED')
      await expect(startGeneration({ source: 'standalone', adapter: 'openai', baseURL: 'http://127.0.0.1:9', model: 'gpt-realtime-2.1-mini', speechTransport: 'realtime' }, 'speech', { prompt: 'x' }, [], signal())).rejects.toThrow('PLUGIN_NETWORK_DISABLED')
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('shows inherited host plugins in settings and an explicit disable removes them from the tool catalog', async () => {
    const root = await directory(), home = join(root, 'home')
    process.env.PULSE_HOME = home
    try {
      await mkdir(home, { recursive: true })
      await writeFile(join(home, 'config.json'), JSON.stringify({ allowNetwork: true, webSearch: { provider: 'custom', baseURL: 'http://127.0.0.1:9/search' }, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'inherited-model' } }, video_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:10', model: 'inherited-video' } }, audio_gen: { enabled: true, modes: { speech: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:11', model: 'inherited-speech', defaults: { voice: 'alloy' } } } }, web_search: { enabled: true } } }))
      const fixture = await settings({ providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock' })
      await mkdir(join(fixture.root, '.pulse'), { recursive: true })
      await writeFile(join(fixture.root, '.pulse', 'config.json'), JSON.stringify({ allowNetwork: true, builtinPlugins: { image_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://workspace.invalid', model: 'evil' } } } }))
      const viewed = await fixture.envelope()
      expect(viewed.config.builtinPlugins).toBeUndefined()
      expect(viewed.config.allowNetwork).toBeUndefined()
      expect(viewed.host).toMatchObject({ allowNetwork: true, allowNetworkSource: 'inherited', pluginSources: { image_gen: 'inherited', web_search: 'inherited' }, webSearchSource: 'inherited' })
      expect(viewed.host.builtinPlugins.image_gen.enabled).toBe(true)
      expect(viewed.host.webSearch.baseURL).toBe('http://127.0.0.1:9/search')
      expect(JSON.stringify(viewed)).not.toContain('workspace.invalid')
      expect(fixture.host.builtinPluginJobs.enabled('image_gen')).toBe(true)
      const next = { ...viewed.config, builtinPlugins: { image_gen: { enabled: false } } }
      const saved = await fetch(fixture.base + '/api/config', { method: 'PUT', headers: fixture.headers, body: JSON.stringify({ version: viewed.version, config: next }) })
      expect(saved.status).toBe(200)
      const body = await saved.json()
      expect(body.host.pluginSources.image_gen).toBe('explicit')
      expect(body.host.pluginSources.video_gen).toBe('inherited')
      expect(body.host.builtinPlugins.image_gen).toMatchObject({ enabled: false, connection: { baseURL: 'http://127.0.0.1:9', model: 'inherited-model' } })
      expect(body.host.builtinPlugins.video_gen).toMatchObject({ enabled: true, connection: { baseURL: 'http://127.0.0.1:10', model: 'inherited-video' } })
      expect(body.host.builtinPlugins.audio_gen).toMatchObject({ enabled: true, modes: { speech: { baseURL: 'http://127.0.0.1:11', model: 'inherited-speech', defaults: { voice: 'alloy' } } } })
      expect(await readFile(fixture.path, 'utf8')).not.toContain('127.0.0.1:9')
      expect(fixture.host.builtinPluginJobs.enabled('video_gen')).toBe(true)
      expect(fixture.host.builtinPluginJobs.enabled('image_gen')).toBe(false)
      expect(fixture.host.builtinPluginJobs.enabled('web_search')).toBe(true)
      const registry = new PluginToolRegistry({ allowNetwork: true }, fixture.host.builtinPluginJobs)
      registerPluginTools(registry, fixture.host.builtinPluginJobs, fixture.root, 'run', fixture.path)
      expect(registry.discover().some(tool => tool.manifest.name === 'image.generate')).toBe(false)
      expect(() => registry.validateInput('image.generate', { prompt: 'x' })).toThrow('TOOL_NOT_ALLOWED')
      expect(registry.discover().some(tool => tool.manifest.name === 'web.search')).toBe(true)
      await expect(fixture.host.builtinPluginJobs.generate(fixture.root, 'run', 'closed', 'image', { prompt: 'x' }, signal(), () => {})).rejects.toThrow('PLUGIN_DISABLED')
      expect(fixture.host.builtinPluginJobs.enabled('audio_gen')).toBe(true)
    } finally { process.env.PULSE_HOME = isolatedHome }
  })
  it('keeps an explicit image connection and audio modes through disable, reload and re-enable', async () => {
    const image = { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'kept-image', credentialRef: 'credential-11111111-1111-4111-8111-111111111111' }
    const speech = { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:9', model: 'kept-speech', defaults: { voice: 'alloy' } }
    const video = { source: 'standalone', adapter: 'openai', baseURL: 'https://api.openai.com/v1', model: 'kept-video' }
    const fixture = await settings({ allowNetwork: true, providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock', builtinPlugins: { image_gen: { enabled: true, connection: image }, audio_gen: { enabled: true, modes: { speech } }, video_gen: { enabled: true, connection: video } } })
    const viewed = await fixture.envelope()
    const disabled = structuredClone(viewed.config)
    disabled.builtinPlugins.image_gen.enabled = false
    disabled.builtinPlugins.audio_gen.enabled = false
    const saved = await fetch(fixture.base + '/api/config', { method: 'PUT', headers: fixture.headers, body: JSON.stringify({ version: viewed.version, config: disabled }) })
    expect(saved.status).toBe(200)
    const stored = JSON.parse(await readFile(fixture.path, 'utf8'))
    expect(stored.builtinPlugins.image_gen).toMatchObject({ enabled: false, connection: image })
    expect(stored.builtinPlugins.audio_gen).toMatchObject({ enabled: false, modes: { speech } })
    expect(stored.builtinPlugins.video_gen).toMatchObject({ enabled: true, connection: video })
    const reloaded = await fixture.envelope()
    expect(reloaded.config.builtinPlugins.image_gen.connection).toMatchObject(image)
    expect(reloaded.config.builtinPlugins.audio_gen.modes.speech).toMatchObject(speech)
    reloaded.config.builtinPlugins.image_gen.enabled = true
    reloaded.config.builtinPlugins.audio_gen.enabled = true
    const reopened = await fetch(fixture.base + '/api/config', { method: 'PUT', headers: fixture.headers, body: JSON.stringify({ version: reloaded.version, config: reloaded.config }) })
    expect(reopened.status).toBe(200)
    const final = JSON.parse(await readFile(fixture.path, 'utf8'))
    expect(final.builtinPlugins.image_gen).toMatchObject({ enabled: true, connection: image })
    expect(final.builtinPlugins.audio_gen).toMatchObject({ enabled: true, modes: { speech } })
    expect(final.builtinPlugins.video_gen.connection.model).toBe('kept-video')
    expect(JSON.stringify(final)).not.toContain('PLUGIN_CONNECTION_REQUIRED')
  })
  it('drops a replaced audio mode and credential after save and refresh, and the next call sends no credential', async () => {
    const home = await directory()
    process.env.PULSE_HOME = home
    process.env.CLEARED_PLUGIN_KEY = 'must-not-be-sent'
    try {
      await mkdir(home, { recursive: true })
      const secret = { source: 'standalone' as const, adapter: 'custom' as const, apiKeyEnv: 'CLEARED_PLUGIN_KEY', credentialRef: 'credential-11111111-1111-4111-8111-111111111111' }
      await writeFile(join(home, 'config.json'), JSON.stringify({ allowNetwork: true, builtinPlugins: { image_gen: { enabled: true, connection: { ...secret, baseURL: 'http://127.0.0.1:9', model: 'inherited-image' } }, audio_gen: { enabled: true, modes: { speech: { ...secret, baseURL: 'http://127.0.0.1:9', model: 'inherited-speech' }, music: { ...secret, baseURL: 'http://127.0.0.1:9', model: 'inherited-music' } } }, video_gen: { enabled: true, connection: { source: 'standalone', adapter: 'custom', baseURL: 'http://127.0.0.1:10', model: 'inherited-video' } } } }))
      let authorization: string | undefined
      const url = await http((req, res) => { authorization = req.headers.authorization; json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] }) })
      const fixture = await settings({ allowNetwork: true, providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock', builtinPlugins: { image_gen: { enabled: true, connection: { ...secret, baseURL: url, model: 'saved-image' } }, audio_gen: { enabled: true, modes: { speech: { ...secret, baseURL: url, model: 'saved-speech' }, music: { ...secret, baseURL: url, model: 'saved-music' } } } } })
      const viewed = await fixture.envelope()
      const next = structuredClone(viewed.config)
      delete next.builtinPlugins.image_gen.connection.credentialRef
      delete next.builtinPlugins.image_gen.connection.apiKeyEnv
      next.builtinPlugins.audio_gen.modes = { speech: { source: 'standalone', adapter: 'custom', baseURL: url, model: 'saved-speech' } }
      const saved = await fetch(fixture.base + '/api/config', { method: 'PUT', headers: fixture.headers, body: JSON.stringify({ version: viewed.version, config: next }) })
      expect(saved.status).toBe(200)
      const body = await saved.json()
      expect(body.host.builtinPlugins.audio_gen.modes.music).toBeUndefined()
      expect(body.host.builtinPlugins.audio_gen.modes.speech).toMatchObject({ model: 'saved-speech' })
      expect(body.host.builtinPlugins.image_gen.connection).toMatchObject({ model: 'saved-image', baseURL: url })
      expect(body.host.builtinPlugins.image_gen.connection.credentialRef).toBeUndefined()
      expect(body.host.builtinPlugins.image_gen.connection.apiKeyEnv).toBeUndefined()
      expect(body.host.builtinPlugins.video_gen).toMatchObject({ enabled: true, connection: { model: 'inherited-video' } })
      const refreshed = await fixture.envelope()
      expect(refreshed.host.builtinPlugins.audio_gen.modes.music).toBeUndefined()
      expect(refreshed.config.builtinPlugins.image_gen.connection).not.toHaveProperty('credentialRef')
      expect(refreshed.config.builtinPlugins.image_gen.connection).not.toHaveProperty('apiKeyEnv')
      await fixture.host.builtinPluginJobs.generate(fixture.root, 'run', 'cleared', 'image', { prompt: 'test' }, signal(), () => {})
      expect(authorization).toBeUndefined()
      await expect(fixture.host.builtinPluginJobs.generate(fixture.root, 'run', 'music', 'music', { prompt: 'test' }, signal(), () => {})).rejects.toThrow('PLUGIN_MODE_NOT_CONFIGURED')
      expect(fixture.host.builtinPluginJobs.enabled('video_gen')).toBe(true)
      expect(fixture.host.builtinPluginJobs.enabled('image_gen')).toBe(true)
      expect(await readFile(fixture.path, 'utf8')).not.toContain('CLEARED_PLUGIN_KEY')
    } finally { process.env.PULSE_HOME = isolatedHome; delete process.env.CLEARED_PLUGIN_KEY }
  })
  it('finishes only the granted job after network is saved off and cancels a known task without a new submission', async () => {
    let posts = 0, gets = 0, deletes = 0
    const url = await http((req, res) => {
      if (req.method === 'POST' && req.url === '/generate') { posts++; json(res, { status: 'queued', id: req.socket.remotePort + '-' + posts }) }
      else if (req.method === 'DELETE') { deletes++; res.writeHead(204).end() }
      else { gets++; json(res, gets > 1 ? { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] } : { status: 'running', id: 'same' }) }
    })
    const finish = await settings(config(url))
    const pending = finish.host.builtinPluginJobs.generate(finish.root, 'run', 'finish', 'image', { prompt: 'test' }, signal(), () => {})
    while (!(await finish.host.builtinPluginJobs.list()).some(job => job.ticket)) await new Promise(r => setTimeout(r, 10))
    const envelope = await finish.envelope()
    envelope.config.allowNetwork = false
    const saved = await fetch(finish.base + '/api/config', { method: 'PUT', headers: finish.headers, body: JSON.stringify({ version: envelope.version, config: envelope.config, pluginDisableDecisions: { image_gen: 'finish' } }) })
    expect(saved.status).toBe(200)
    expect((await pending).mediaType).toBe('image/png')
    expect(posts).toBe(1)
    expect(deletes).toBe(0)
    await expect(finish.host.builtinPluginJobs.generate(finish.root, 'run', 'new', 'image', { prompt: 'test' }, signal(), () => {})).rejects.toThrow('PLUGIN_DISABLED')
    expect(posts).toBe(1)
    const cancelURL = await http((req, res) => { if (req.method === 'DELETE') { deletes++; res.writeHead(204).end() } else if (req.method === 'POST') { posts++; json(res, { status: 'queued', id: 'cancel-me' }) } else json(res, { status: 'running', id: 'cancel-me' }) })
    const stopping = await settings(config(cancelURL))
    const running = stopping.host.builtinPluginJobs.generate(stopping.root, 'run', 'stop', 'image', { prompt: 'test' }, signal(), () => {})
    while (!(await stopping.host.builtinPluginJobs.list()).some(job => job.ticket)) await new Promise(r => setTimeout(r, 10))
    const current = await stopping.envelope()
    current.config.allowNetwork = false
    const stopped = await fetch(stopping.base + '/api/config', { method: 'PUT', headers: stopping.headers, body: JSON.stringify({ version: current.version, config: current.config, pluginDisableDecisions: { image_gen: 'cancel' } }) })
    expect(stopped.status).toBe(200)
    await expect(running).rejects.toThrow('PLUGIN_CANCELLED')
    expect(deletes).toBe(1)
    expect((await stopping.host.builtinPluginJobs.list())[0]).toMatchObject({ state: 'cancelled', remoteCancellation: 'requested' })
  })
  it('does not contact the network when recovering without a grant, and resumes only a persisted finish grant', async () => {
    let requests = 0
    const url = await http((req, res) => { requests++; json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] }) })
    const blocked = await manager({ ...config(url), allowNetwork: false })
    const id = blocked.jobs.id('run', 'cold')
    await mkdir(blocked.jobs.directory, { recursive: true })
    await writeFile(join(blocked.jobs.directory, id + '.json'), JSON.stringify({ id, pluginId: 'image_gen', kind: 'image', runId: 'run', root: blocked.root, createdAt: Date.now(), deadline: Date.now() + 10000, state: 'running', ownerPid: 99999999, ticket: { provider: 'custom', id: 'saved' }, connection: { source: 'standalone', adapter: 'custom', baseURL: url, model: 'x' } }))
    const stop = await blocked.jobs.recoverPending()
    await new Promise(r => setTimeout(r, 50))
    stop()
    expect(requests).toBe(0)
    expect((await blocked.jobs.read(id))?.state).toBe('running')
    await writeFile(join(blocked.jobs.directory, id + '.grant'), 'finish')
    const again = await blocked.jobs.recoverPending()
    try {
      for (let n = 0; n < 50 && (await blocked.jobs.read(id))?.state !== 'succeeded'; n++) await new Promise(r => setTimeout(r, 10))
      expect((await blocked.jobs.read(id))?.state).toBe('succeeded')
      expect(requests).toBe(1)
    } finally { again() }
  })
  it('keeps a launch --no-network restriction across config apply for plugins and web.fetch', async () => {
    let requests = 0
    const url = await http((_req, res) => { requests++; json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] }) })
    const cfg = { ...config(url), providers: { fixture: { provider: 'mock', models: { fixture: { modelCode: 'fixture' } } } }, activeModel: 'fixture/fixture' }
    const fixture = await settings(cfg, { networkOverride: false })
    expect(fixture.host.launchNetworkOverride()).toBe(false)
    expect(fixture.host.builtinPluginJobs.enabled('image_gen')).toBe(false)
    const envelope = await fixture.envelope()
    expect(envelope.launchNetwork).toEqual({ override: false })
    expect(envelope.config.allowNetwork).toBe(true)
    const saved = await fetch(fixture.base + '/api/config', { method: 'PUT', headers: fixture.headers, body: JSON.stringify({ version: envelope.version, config: envelope.config }) })
    expect(saved.status).toBe(200)
    expect(fixture.host.launchNetworkOverride()).toBe(false)
    expect(fixture.host.getWorkWorkerOptions().allowNetwork).toBe(false)
    expect(fixture.host.getWorkWorkerOptions().builtinPluginNetworkOverride).toBe(false)
    expect(fixture.host.builtinPluginJobs.enabled('web_search')).toBe(false)
    await expect(fixture.host.builtinPluginJobs.generate(fixture.root, 'run', 'blocked', 'image', { prompt: 'test' }, signal(), () => {})).rejects.toThrow('PLUGIN_DISABLED')
    const granted = fixture.host.builtinPluginJobs.id('run', 'hard')
    await mkdir(fixture.host.builtinPluginJobs.directory, { recursive: true })
    await writeFile(join(fixture.host.builtinPluginJobs.directory, granted + '.json'), JSON.stringify({ id: granted, pluginId: 'image_gen', kind: 'image', runId: 'run', root: fixture.root, createdAt: Date.now(), deadline: Date.now() + 10000, state: 'running', ownerPid: 99999999, ticket: { provider: 'custom', id: 'saved' }, connection: { source: 'standalone', adapter: 'custom', baseURL: url, model: 'x' }, networkGrant: 'finish' }))
    await writeFile(join(fixture.host.builtinPluginJobs.directory, granted + '.grant'), 'finish')
    const stop = await fixture.host.builtinPluginJobs.recoverPending()
    await new Promise(r => setTimeout(r, 40))
    stop()
    expect(requests).toBe(0)
    expect((await fixture.host.builtinPluginJobs.read(granted))?.state).toBe('running')
    const { builtinPluginNetworkOverride: _ignored, ...withoutOverride } = fixture.host.getWorkWorkerOptions()
    fixture.host.applyLiveOptions({ ...withoutOverride, allowNetwork: true })
    expect(fixture.host.launchNetworkOverride()).toBe(false)
    expect(fixture.host.getWorkWorkerOptions().allowNetwork).toBe(false)
  })
})

it.each([true, false])('lets an enabled host plugin generate autonomously in ask mode (assistant=%s)', async assistantChat => {
  let calls = 0
  const service = await http((_req, res) => { calls++; json(res, { status: 'succeeded', outputs: [{ mediaType: 'image/png', dataBase64: png.toString('base64') }] }) })
  const { root, path } = await manager(config(service))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), builtinPluginConfigPath: path, allowNetwork: true, approvalMode: 'ask', taskController: false, provider: { provider: 'mock', defaultModel: 'fixture' }, providerProfiles: { fixture: { provider: 'mock', defaultModel: 'fixture' } }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', assistantModel: 'fixture', activeProviderCode: 'fixture', mockToolCalls: [{ name: 'image.generate', input: { prompt: 'test' } }], mockAfterToolResponse: 'Generated the image.' })
  closers.push(() => host.close())
  const conversation = await host.createConversation()
  const run = await host.sendMessage(conversation.id, { text: '生成一张测试图片', assistantChat })
  for await (const event of run.events) expect(event.type).not.toBe('human_required')
  expect((await run.outcome()).status).toBe('succeeded'); expect(calls).toBe(1)
  const artifacts = await host.listArtifacts(conversation.id)
  expect(JSON.stringify(artifacts)).toContain('.pulse-generated')
})
