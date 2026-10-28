import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { ProviderCredentialStore, resolveProviderApiKey } from '../packages/server/src/providers/credentials.js'
import { providerPresets, resolveProviderVariant } from '../packages/server/src/providers/catalog.js'
import { mergeDiscoveredModels, normalizeDiscoveredModel, ProviderOnboarding } from '../packages/server/src/providers/onboarding.js'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { hostOptions, parse } from '../packages/cli/src/bin.js'
import { sanitizeWorkspaceConfig } from '../packages/cli/src/config.js'
import { createHostModelRouting, isLocalModelProvider } from '../packages/server/src/model-routing.js'
import { resolveModelCapability } from '../packages/adapters/src/providers/canonical/index.js'

const roots: string[] = []
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of closers.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function workspace() { const root = await mkdtemp(join(tmpdir(), 'pulse-provider-connect-')); roots.push(root); return { root, path: join(root, 'config.json') } }
async function http(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  closers.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
const json = (res: ServerResponse, value: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()) }
const remoteModel = { id: 'vendor/chat', name: '对话模型', supported_parameters: ['tools', 'response_format'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, context_length: 64000 }

describe('provider presets and discovery', () => {
  it('contains the agreed vendors, defaults Chinese vendors to China, and blocks GLM Coding Plan', () => {
    expect(providerPresets.filter(item => item.category !== 'custom')).toHaveLength(12)
    expect(providerPresets.map(item => item.id)).toEqual(expect.arrayContaining(['ollama', 'deepseek', 'minimax', 'zhipu', 'openai', 'anthropic', 'gemini', 'bailian', 'volcengine', 'moonshot', 'siliconflow', 'openrouter', 'custom']))
    expect(resolveProviderVariant('minimax', 'cn-api').variant.baseURL).toContain('api.minimax.cn')
    expect(() => resolveProviderVariant('zhipu', 'coding')).toThrow('PROVIDER_VARIANT_UNAVAILABLE')
    expect(resolveProviderVariant('volcengine', 'coding').variant.baseURL).not.toEqual(resolveProviderVariant('volcengine', 'api').variant.baseURL)
  })
  it.each([
    { id: 'text-embedding-3-small' }, { id: 'vendor/reranker' }, { id: 'picture', architecture: { output_modalities: ['image'] } }, { id: 'voice', sub_type: 'speech-to-text' },
  ])('excludes non-conversation models: %j', item => { expect(normalizeDiscoveredModel(item)).toBeUndefined() })
  it('keeps unknown abilities unknown and imports authoritative capability metadata', () => {
    expect(normalizeDiscoveredModel({ id: 'plain' })).toMatchObject({ tools: 'unknown', structuredOutput: 'unknown', imageInput: 'unknown' })
    expect(normalizeDiscoveredModel(remoteModel)).toMatchObject({ modelCode: 'vendor/chat', tools: 'supported', structuredOutput: 'supported', imageInput: 'supported', maxContextTokens: 64000 })
    expect(normalizeDiscoveredModel({ id: 'chat-only', supported_parameters: [] })).toMatchObject({ tools: 'unsupported' })
  })
  it('fetches the directory with a temporary Key and keeps secrets out of the result', async () => {
    const { path } = await workspace(); let authorization: string | undefined
    const baseURL = await http((req, res) => { authorization = req.headers.authorization; json(res, { data: [remoteModel, { id: 'embedding-x' }] }) })
    const result = await new ProviderOnboarding(path).discover({ presetId: 'custom', connectionVariant: 'custom', apiKey: 'temporary-secret', baseURL }, {})
    expect(authorization).toBe('Bearer temporary-secret')
    expect(result).toMatchObject({ authenticated: false, source: 'remote', models: [{ modelCode: 'vendor/chat' }] })
    expect(JSON.stringify(result)).not.toContain('temporary-secret')
    expect(await readdir(join(path, '..'))).toEqual([])
  })
  it.each([401, 403, 404, 429, 500])('reports HTTP %i without using a fallback catalog or raw error body', async status => {
    const { path } = await workspace()
    const baseURL = await http((_req, res) => json(res, { error: 'echoed-private-secret' }, status))
    await expect(new ProviderOnboarding(path).discover({ presetId: 'custom', connectionVariant: 'custom', apiKey: 'private-secret', baseURL }, {})).rejects.toThrow(`PROVIDER_HTTP_${status}`)
  })
  it('does not treat an official static catalog as Key authentication', async () => {
    const { path } = await workspace()
    const request = vi.spyOn(globalThis, 'fetch')
    const result = await new ProviderOnboarding(path).discover({ presetId: 'minimax', connectionVariant: 'cn-plan', apiKey: 'unverified-key' }, {})
    expect(request).not.toHaveBeenCalled()
    expect(result).toMatchObject({ source: 'catalog', authenticated: false, catalogVersion: '2026-10-28' })
  })
  it('follows Anthropic pagination and rejects repeated cursors', async () => {
    const { path } = await workspace(); let requests = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      requests++; const next = String(url).includes('after_id=first')
      return new Response(JSON.stringify({ data: [{ id: next ? 'second' : 'first' }], has_more: !next, last_id: 'first' }))
    })
    const service = new ProviderOnboarding(path)
    const result = await service.discover({ presetId: 'anthropic', connectionVariant: 'api', apiKey: 'key' }, {})
    expect(result.models.map(item => item.modelCode)).toEqual(['first', 'second']); expect(requests).toBe(2)
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: [], has_more: true, last_id: 'repeat' })))
    // Return a fresh response for each request.
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ data: [], has_more: true, last_id: 'repeat' })))
    await expect(service.discover({ presetId: 'anthropic', connectionVariant: 'api', apiKey: 'key' }, {})).rejects.toThrow('PROVIDER_MODEL_PAGINATION_INVALID')
  })
  it('refreshes discovered values while preserving manual overrides and missing referenced models', () => {
    const old = normalizeDiscoveredModel(remoteModel)!
    const previous = { renamed: { ...old, displayName: '用户名称', discovery: old, maxOutputTokens: 2000 }, retained: { modelCode: 'removed-from-directory' } }
    const next = mergeDiscoveredModels(previous, [{ ...old, displayName: '新远程名称', maxContextTokens: 128000 }])
    expect(next.renamed).toMatchObject({ displayName: '用户名称', maxOutputTokens: 2000, maxContextTokens: 128000, discovery: { displayName: '新远程名称' } })
    expect(next.retained).toEqual(previous.retained); expect(next['vendor/chat']).toBeUndefined()
  })
})

describe('provider credential storage and CLI resolution', () => {
  it('isolates accounts, writes restrictive permissions, and resolves explicit references before environment values', async () => {
    const { path } = await workspace(), store = new ProviderCredentialStore(path)
    vi.stubEnv('PROVIDER_TEST_KEY', 'environment-secret')
    const [one, two] = await Promise.all([store.add('account-one'), new ProviderCredentialStore(path).add('account-two')])
    expect(await store.get(one)).toBe('account-one'); expect(await store.get(two)).toBe('account-two')
    expect(await resolveProviderApiKey({ provider: 'openai', credentialRef: one, apiKeyEnv: 'PROVIDER_TEST_KEY' }, path)).toBe('account-one')
    expect(await resolveProviderApiKey({ provider: 'openai', apiKeyEnv: 'PROVIDER_TEST_KEY' }, path)).toBe('environment-secret')
    await store.remove(one)
    await expect(resolveProviderApiKey({ provider: 'openai', credentialRef: one, apiKeyEnv: 'PROVIDER_TEST_KEY' }, path)).rejects.toThrow('PROVIDER_CREDENTIAL_MISSING')
    expect(await store.get(two)).toBe('account-two')
    if (process.platform !== 'win32') expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(path, '..'))).toEqual(['provider-credentials.json'])
  })
  it('rejects symbolic links without changing the target', async () => {
    const { root, path } = await workspace(), store = new ProviderCredentialStore(path), target = join(root, 'target')
    await writeFile(target, '{}'); await symlink(target, store.path)
    await expect(store.add('secret')).rejects.toThrow('PROVIDER_CREDENTIAL_STORE_UNAVAILABLE')
    expect(await readFile(target, 'utf8')).toBe('{}')
  })
  it('uses the same credential for main, routed, chat, front and DeepSeek approval profiles with custom config paths', async () => {
    const { path, root } = await workspace(); vi.stubEnv('PULSE_HOME', root)
    const ref = await new ProviderCredentialStore(path).add('shared-account-secret')
    await writeFile(path, JSON.stringify({ providers: { ds: { provider: 'deepseek', credentialRef: ref, baseURL: 'https://api.deepseek.com', models: { chat: { modelCode: 'deepseek-chat' } } } }, activeModel: 'ds/chat', assistantModel: 'ds/chat', frontModel: { enabled: true, model: 'ds/chat' }, approvalReview: { model: 'ds/chat' }, taskRouting: { reason: ['ds/chat'] } }))
    const options = await hostOptions(parse(['--config', path]))
    expect(options.provider?.apiKey).toBe('shared-account-secret')
    expect(options.providerProfiles?.ds?.apiKey).toBe('shared-account-secret')
    expect(options.frontModel?.apiKey).toBe('shared-account-secret')
    expect(options.approvalReview?.apiKey).toBe('shared-account-secret')
    expect(options.assistantModel).toBe('ds/chat'); expect(options.taskRouting?.reason).toEqual(['ds/chat'])
    const sanitized = sanitizeWorkspaceConfig({ providers: { ds: { provider: 'deepseek', credentialRef: ref, apiKeyEnv: 'PROVIDER_TEST_KEY', presetId: 'deepseek', connectionVariant: 'api' } } })
    expect(sanitized.providers?.ds).not.toHaveProperty('credentialRef')
    expect(sanitized.providers?.ds).not.toHaveProperty('apiKeyEnv')
  })
})

async function management() {
  const { path, root } = await workspace()
  const initial = { activeModel: 'mock/mock', approvalMode: 'auto', providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, retained: 'user-content' }
  await writeFile(path, JSON.stringify(initial))
  const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), approvalMode: 'ask' })
  let failValidation = false
  const server = new H5Server(host, { dataDir: join(root, 'data'), host: '127.0.0.1', port: 0, configuration: { path, prepare: async file => {
    if (failValidation) throw new Error('deliberate validation failure')
    const config = JSON.parse(await readFile(file, 'utf8'))
    for (const source of Object.values(config.providers) as any[]) if (source.credentialRef) await resolveProviderApiKey(source, file)
    return { cwd: root, dataDir: join(root, 'data'), approvalMode: config.approvalMode, activeModel: config.activeModel }
  } } })
  const info = await server.start(), base = `http://127.0.0.1:${info.port}`
  closers.push(async () => { await server.stop(); await host.close() })
  const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
  const headers = { Origin: base, Cookie: session.headers.get('set-cookie')!, 'Content-Type': 'application/json' }
  const get = async () => (await fetch(base + '/api/config', { headers })).json()
  const post = (route: string, input: unknown, customHeaders = headers) => fetch(base + route, { method: 'POST', headers: customHeaders, body: JSON.stringify(input) })
  return { path, root, host, server, base, headers, get, post, fail: () => { failValidation = true } }
}

describe('provider management HTTP API', () => {
  it('saves a connection atomically without putting the Key into config, responses or backups; supports multiple accounts and Key rotation', async () => {
    const api = await management(), before = await api.get()
    const input = { presetId: 'minimax', connectionVariant: 'cn-plan', apiKey: 'first-secret', modelCode: 'MiniMax-M3.1-Flash', models: [{ modelCode: 'MiniMax-M3.1-Flash' }], version: before.version, setDefault: false }
    const response = await api.post('/api/providers/connect', input), connected = await response.json()
    expect(response.status).toBe(200); expect(connected.config.retained).toBe('user-content'); expect(connected.config.activeModel).toBe('mock/mock')
    expect(JSON.stringify(connected)).not.toContain('first-secret')
    expect(await readFile(api.path, 'utf8')).not.toContain('first-secret'); expect(await readFile(api.path + '.bak', 'utf8')).not.toContain('first-secret')
    expect(api.host.getAutomationOptions().approvalMode).toBe('ask')
    const store = new ProviderCredentialStore(api.path), oldRef = connected.config.providers[connected.providerId].credentialRef
    expect(await store.get(oldRef)).toBe('first-secret')
    const second = await (await api.post('/api/providers/connect', { ...input, version: connected.version, apiKey: 'second-secret' })).json()
    expect(second.providerId).not.toBe(connected.providerId)
    const rotated = await (await api.post('/api/providers/connect', { ...input, version: second.version, providerId: connected.providerId, apiKey: 'rotated-secret' })).json()
    expect(await store.get(rotated.config.providers[connected.providerId].credentialRef)).toBe('rotated-secret')
    expect(await store.get(oldRef)).toBe('first-secret') // In-flight tasks/backups keep their original credential.
    const stale = await api.post('/api/providers/connect', input)
    expect(stale.status).toBe(409)
  })
  it('cleans newly written credentials on validation failure and preserves the config', async () => {
    const api = await management(), before = await api.get(), text = await readFile(api.path, 'utf8'); api.fail()
    const response = await api.post('/api/providers/connect', { presetId: 'minimax', connectionVariant: 'cn-api', apiKey: 'must-rollback', version: before.version, models: [{ modelCode: 'one' }] })
    expect(response.status).toBe(400); expect(await readFile(api.path, 'utf8')).toBe(text)
    expect(await readFile(new ProviderCredentialStore(api.path).path, 'utf8')).toBe('{}')
    expect(await readdir(api.root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$|\.lock$/)]))
  })
  it('requires a local management session and same origin and refuses unavailable plans', async () => {
    const api = await management()
    expect((await fetch(api.base + '/api/provider-presets')).status).toBe(401)
    const pair = await fetch(api.base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: api.server.createPairingCode().code, name: 'Phone' }) })
    const pairedHeaders = { ...api.headers, Cookie: pair.headers.get('set-cookie')! }
    expect((await fetch(api.base + '/api/provider-presets', { headers: pairedHeaders })).status).toBe(403)
    for (const route of ['discover', 'probe', 'connect']) expect((await api.post(`/api/providers/${route}`, {}, pairedHeaders)).status).toBe(403)
    expect((await fetch(api.base + '/api/provider-presets', { headers: api.headers })).status).toBe(200)
    for (const route of ['discover', 'probe', 'connect']) expect((await api.post(`/api/providers/${route}`, {}, { ...api.headers, Origin: 'https://untrusted.example' })).status).toBe(403)
    const response = await api.post('/api/providers/discover', { presetId: 'zhipu', connectionVariant: 'coding', apiKey: 'unused' })
    expect(await response.json()).toEqual({ error: 'PROVIDER_VARIANT_UNAVAILABLE' })
  })
  it('verifies streaming, tool continuation and JSON in exactly three calls without executing local tools', async () => {
    const api = await management(); let count = 0; const payloads: any[] = []
    const baseURL = await http(async (req, res) => {
      const value = await body(req); payloads.push(value); count++
      if (count === 2) return json(res, { choices: [{ message: { content: null, reasoning_content: 'private thought', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'pulse_echo', arguments: '{"value":"PULSE_OK"}' } }] }, finish_reason: 'tool_calls' }] })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: count === 1 ? 'PULSE_OK' : '{"ok":true}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    const response = await api.post('/api/providers/probe', { presetId: 'custom', connectionVariant: 'custom', apiKey: 'probe-key', baseURL, modelCode: 'test' }), result = await response.json()
    expect(response.status).toBe(200); expect(result).toMatchObject({ chat: { status: 'passed' }, tools: { status: 'passed' }, structuredOutput: { status: 'passed' } }); expect(count).toBe(3)
    expect(payloads[2].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', content: 'PULSE_OK', tool_call_id: 'call-1' }), expect.objectContaining({ role: 'assistant', reasoning_content: 'private thought' })]))
    expect(JSON.stringify(result)).not.toContain('probe-key'); expect(JSON.stringify(result)).not.toContain('private thought')
  })
})

describe('Ollama local, cloud and self-hosted onboarding', () => {
  it('discovers local models using /api/tags without a Key, preserves names and filters embeddings', async () => {
    const { path } = await workspace(); let authorization: string | undefined, route: string | undefined
    const baseURL = await http((req, res) => { authorization = req.headers.authorization; route = req.url; json(res, { models: [{ name: 'qwen3.5:4b' }, { name: 'embeddinggemma:latest' }, { name: 'gpt-oss:120b-cloud' }, { name: 'custom-alias', remote_host: 'https://ollama.com' }] }) })
    const result = await new ProviderOnboarding(path).discover({ presetId: 'ollama', connectionVariant: 'local', baseURL }, {})
    expect(route).toBe('/api/tags'); expect(authorization).toBeUndefined()
    expect(result.models.map(item => item.modelCode)).toEqual(['qwen3.5:4b', 'gpt-oss:120b-cloud', 'custom-alias'])
    expect(result.models[1]?.remote).toBe(true); expect(result.models[2]?.remote).toBe(true)
    expect(await readdir(join(path, '..'))).toEqual([])
  })
  it('saves and refreshes an unauthenticated local connection without creating a credential file', async () => {
    const api = await management(), initial = await api.get()
    const input = { presetId: 'ollama', connectionVariant: 'local', models: [{ modelCode: 'qwen3.5:4b' }], setDefault: false, version: initial.version }
    const first = await (await api.post('/api/providers/connect', input)).json()
    expect(first.config.providers[first.providerId]).toMatchObject({ provider: 'ollama', baseURL: 'http://127.0.0.1:11434/v1' })
    expect(first.config.providers[first.providerId].credentialRef).toBeUndefined()
    const second = await api.post('/api/providers/connect', { ...input, providerId: first.providerId, version: first.version })
    expect(second.status).toBe(200)
    expect(await readdir(api.root)).not.toContain('provider-credentials.json')
  })
  it('uses the official cloud endpoint and bearer authentication, with no local installation dependency', async () => {
    const { path } = await workspace(), service = new ProviderOnboarding(path)
    await expect(service.discover({ presetId: 'ollama', connectionVariant: 'cloud' }, {})).rejects.toThrow('PROVIDER_CREDENTIAL_MISSING')
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ models: [{ model: 'gemma4:31b' }] })))
    const result = await service.discover({ presetId: 'ollama', connectionVariant: 'cloud', apiKey: 'cloud-secret', baseURL: 'http://untrusted.invalid' }, {})
    expect(String(request.mock.calls[0]![0])).toBe('https://ollama.com/api/tags')
    expect(request.mock.calls[0]![1]?.headers).toEqual({ authorization: 'Bearer cloud-secret' })
    expect(result.models[0]).toMatchObject({ modelCode: 'gemma4:31b', remote: true, structuredOutput: 'unsupported' })
    expect(JSON.stringify(result)).not.toContain('cloud-secret')
  })
  it('normalizes self-hosted base paths and does not borrow the official cloud Key', async () => {
    const { path } = await workspace(), service = new ProviderOnboarding(path)
    vi.stubEnv('OLLAMA_API_KEY', 'private-cloud-key')
    const connected = await service.connection({ presetId: 'ollama', connectionVariant: 'remote', baseURL: 'http://192.168.1.20:11434/api' }, {})
    expect(connected.provider).toMatchObject({ provider: 'ollama-remote', baseURL: 'http://192.168.1.20:11434/v1' })
    expect(connected.apiKey).toBe('')
    expect(await resolveProviderApiKey({ provider: 'ollama-remote' }, path)).toBeUndefined()
    expect(await resolveProviderApiKey({ provider: 'ollama-cloud' }, path)).toBe('private-cloud-key')
    expect(await resolveProviderApiKey({ provider: 'ollama', apiKeyEnv: 'OLLAMA_API_KEY' }, path)).toBe('private-cloud-key')
    await expect(service.connection({ presetId: 'ollama', connectionVariant: 'remote', baseURL: 'http://public.example' }, {})).rejects.toThrow('PROVIDER_ENDPOINT_INVALID')
    await expect(service.connection({ presetId: 'ollama', connectionVariant: 'local', baseURL: 'https://ollama.com/v1' }, {})).rejects.toThrow('PROVIDER_ENDPOINT_INVALID')
  })
  it('keeps cloud/remote services and local cloud aliases out of local-only routing', () => {
    expect(isLocalModelProvider({ provider: 'ollama', baseURL: 'http://localhost:11434', defaultModel: 'qwen3.5:4b' })).toBe(true)
    for (const profile of [
      { provider: 'ollama-cloud', baseURL: 'https://ollama.com/v1' },
      { provider: 'ollama-remote', baseURL: 'http://localhost:11434/v1' },
      { provider: 'ollama', baseURL: 'https://my-server.example/v1' },
      { provider: 'ollama', defaultModel: 'gpt-oss:120b-cloud' },
    ]) expect(isLocalModelProvider(profile)).toBe(false)
    const routing = createHostModelRouting({ activeModel: 'local/alias', activeProvider: { provider: 'ollama' }, activeProviderCode: 'local', providerModels: { 'local/alias': { provider: 'local', model: 'custom-alias', remote: true } } })
    expect(routing.candidates[0]?.capabilities.local).toBe(false)
    expect(resolveModelCapability('gemma4:31b', 'ollama-cloud')).toMatchObject({ structuredOutput: 'unsupported', reasoning: 'effort_param' })
    expect(resolveModelCapability('qwen3.5:4b', 'ollama')).toMatchObject({ structuredOutput: 'native_strict', reasoning: 'effort_param' })
  })
  it('rejects cloud models as local approval reviewers, including aliased cloud models', async () => {
    const { path, root } = await workspace(); vi.stubEnv('PULSE_HOME', root)
    for (const model of [{ modelCode: 'gpt-oss:120b-cloud' }, { modelCode: 'alias', remote: true }]) {
      await writeFile(path, JSON.stringify({ providers: { local: { provider: 'ollama', models: { cloud: model } }, mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock', approvalReview: { model: 'local/cloud' } }))
      await expect(hostOptions(parse(['--config', path]))).rejects.toThrow('APPROVAL_REVIEW_PROVIDER_UNSUPPORTED')
    }
  })
  it('counts compatibility retries in the three-request probe budget', async () => {
    const { path } = await workspace(); let calls = 0
    const baseURL = await http(async (req, res) => {
      const sent = await body(req); calls++
      if (sent.reasoning_effort) return json(res, { error: { message: 'reasoning_effort is unsupported' } }, 400)
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'PULSE_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    const result = await new ProviderOnboarding(path).probe({ presetId: 'ollama', connectionVariant: 'local', baseURL, modelCode: 'old-server' }, {})
    expect(result.chat.status).toBe('passed')
    expect(result.tools).toEqual({ status: 'failed', code: 'PROVIDER_PROBE_BUDGET_EXHAUSTED' })
    expect(calls).toBe(3)
  })
})
