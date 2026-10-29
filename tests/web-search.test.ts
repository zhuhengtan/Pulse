import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createWebSearchTool, parseWebSearchConfig, resolveWebSearchOptions, searchWeb } from '../packages/server/src/web-search.js'
import { readPublicPage } from '../packages/server/src/web.js'
import { createLocalHost, H5Server } from '../packages/server/src/index.js'
import { ProviderCredentialStore } from '../packages/server/src/providers/credentials.js'
import { loadPulseConfig, sanitizeWorkspaceConfig } from '../packages/cli/src/config.js'
import { hostOptions, parse } from '../packages/cli/src/bin.js'
import { ToolRegistry } from '@hunterzhu/pulse-tool-sdk'

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const close of closers.splice(0).reverse()) await close() })
const signal = () => new AbortController().signal
const mockProfile = { provider: 'mock' as const, defaultModel: 'fixture' }
const mockAssistant = { provider: mockProfile, providerProfiles: { fixture: mockProfile }, providerModels: { fixture: { provider: 'fixture', model: 'fixture' } }, activeModel: 'fixture', activeProviderCode: 'fixture', assistantModel: 'fixture' }
const row = { title: 'Example', url: 'https://example.com/', snippet: 'A source' }
const json = (res: ServerResponse, data: unknown, code = 200) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data))
async function http(handler: (req: IncomingMessage, res: ServerResponse) => void, host = '127.0.0.1') {
  const server = createServer(handler); server.listen(0, host); await once(server, 'listening')
  closers.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, port: (server.address() as { port: number }).port }
}
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()) }
async function workspace() { const root = await mkdtemp(join(tmpdir(), 'pulse-search-')); closers.push(() => rm(root, { recursive: true, force: true })); return { root, path: join(root, 'config.json') } }

describe('search backends', () => {
  it('calls a local custom service with JSON and bearer authentication, limits/deduplicates results and omits unsafe URLs', async () => {
    let input: unknown, auth: string | undefined
    const service = await http(async (req, res) => { input = await body(req); auth = req.headers.authorization; json(res, { results: [row, row, { ...row, url: 'http://127.0.0.1/private' }, { ...row, url: 'https://example.org/' }] }) })
    const result = await searchWeb('中文搜索', 1, signal(), { provider: 'custom', baseURL: service.url + '/search', apiKey: 'fixture-secret' })
    expect(input).toEqual({ query: '中文搜索', limit: 1 }); expect(auth).toBe('Bearer fixture-secret')
    expect(result).toMatchObject({ query: '中文搜索', results: [row] }); expect(result.fetchedAt).toBeTruthy()
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
  })
  it('supports SearXNG instance prefixes and maps content to snippet', async () => {
    let path = ''
    const service = await http((req, res) => { path = req.url!; json(res, { results: [{ title: row.title, url: row.url, content: row.snippet }] }) })
    expect((await searchWeb('hello', 5, signal(), { provider: 'searxng', baseURL: service.url + '/prefix/' })).results).toEqual([row])
    expect(path).toBe('/prefix/search?format=json&q=hello')
    await searchWeb('again', 5, signal(), { provider: 'searxng', baseURL: service.url + '/search' })
    expect(path).toBe('/search?format=json&q=again')
  })
  it('uses a configured DuckDuckGo HTML endpoint and supports empty results', async () => {
    const service = await http((_req, res) => res.end('<a class="result__a" href="https://example.com/">Example</a><a class="result__snippet">A source</a>'))
    expect((await searchWeb('test', 5, signal(), { provider: 'duckduckgo', baseURL: service.url })).results).toEqual([row])
    const empty = await http((_req, res) => json(res, { results: [] }))
    expect((await searchWeb('test', 5, signal(), { provider: 'custom', baseURL: empty.url })).results).toEqual([])
  })
  it('keeps the legacy endpoint and gives explicit configuration precedence', async () => {
    vi.stubEnv('PULSE_SEARCH_URL', 'https://html.duckduckgo.com/legacy')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''))
    await searchWeb('test', 5, signal())
    expect(String(fetcher.mock.calls[0]![0])).toContain('/legacy?q=test')
    fetcher.mockResolvedValueOnce(new Response('{"results":[]}'))
    await searchWeb('test', 5, signal(), { provider: 'custom', baseURL: 'http://localhost:9999/explicit' })
    expect(String(fetcher.mock.calls[1]![0])).toBe('http://localhost:9999/explicit')
  })
  it.each([401, 403, 429, 500])('reports HTTP %i without leaking the response or trying a fallback', async code => {
    let calls = 0
    const service = await http((_req, res) => { calls++; json(res, { error: 'echoed-secret' }, code) })
    await expect(searchWeb('test', 5, signal(), { provider: 'custom', baseURL: service.url })).rejects.toThrow(`WEB_SEARCH_${code < 404 ? 'AUTH' : 'HTTP'}_${code}`)
    expect(calls).toBe(1)
  })
  it('blocks redirects including cross-origin credential forwarding', async () => {
    let targetCalls = 0
    const target = await http((_req, res) => { targetCalls++; res.end() })
    const service = await http((_req, res) => res.writeHead(302, { location: target.url }).end())
    await expect(searchWeb('test', 5, signal(), { provider: 'custom', baseURL: service.url, apiKey: 'private' })).rejects.toThrow('WEB_SEARCH_REDIRECT_BLOCKED')
    expect(targetCalls).toBe(0)
  })
  it.each(['not-json', '{}', '{"results":[{"url":"https://example.com"}]}'])('rejects malformed responses: %s', async text => {
    const service = await http((_req, res) => res.end(text))
    await expect(searchWeb('test', 5, signal(), { provider: 'custom', baseURL: service.url })).rejects.toThrow('WEB_SEARCH_PROTOCOL_ERROR')
  })
  it('bounds response size during streaming', async () => {
    const service = await http((_req, res) => res.end('x'.repeat(1_000_001)))
    await expect(searchWeb('test', 5, signal(), { provider: 'custom', baseURL: service.url })).rejects.toThrow('WEB_SEARCH_RESPONSE_TOO_LARGE')
  })
  it('times out stalled responses and cancels requests', async () => {
    const service = await http(() => {})
    await expect(searchWeb('test', 5, signal(), { provider: 'custom', baseURL: service.url, timeoutMs: 100 })).rejects.toThrow('WEB_SEARCH_TIMEOUT')
    const controller = new AbortController()
    const request = searchWeb('test', 5, controller.signal, { provider: 'custom', baseURL: service.url })
    controller.abort()
    await expect(request).rejects.toThrow('WEB_SEARCH_CANCELLED')
  })
  it('hides raw transport errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-token in request')))
    await expect(searchWeb('test', 5, signal(), { provider: 'custom', baseURL: 'http://localhost:1234' })).rejects.toThrow('WEB_SEARCH_NETWORK_ERROR')
  })
  it('accepts a LAN endpoint while public page reads still reject it and loopback', async () => {
    const address = Object.values(networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address
    if (!address) return
    const service = await http((_req, res) => json(res, { results: [row] }), '0.0.0.0')
    const url = `http://${address}:${service.port}/search`
    // Unit-test setup intentionally permits only loopback sockets; exercise the LAN grant at the adapter boundary.
    const loopbackFetch = globalThis.fetch
    const requested = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      expect(String(input)).toBe(url)
      return loopbackFetch(service.url + '/search', init)
    })
    expect((await searchWeb('test', 5, signal(), { provider: 'custom', baseURL: url })).results).toEqual([row])
    requested.mockRestore()
    await expect(readPublicPage(url, signal())).rejects.toThrow('PRIVATE_NETWORK_URL_NOT_ALLOWED')
    await expect(readPublicPage(service.url, signal())).rejects.toThrow('PRIVATE_NETWORK_URL_NOT_ALLOWED')
  })
  it('captures options for tools and does not grant access to other hosts', async () => {
    const service = await http((_req, res) => json(res, { results: [row] }))
    const options = { provider: 'custom' as const, baseURL: service.url }
    const registry = new ToolRegistry({ allowNetwork: true, networkHosts: [] })
    registry.register(createWebSearchTool(options)); options.baseURL = 'http://localhost:1'
    expect(await registry.execute('web.search', { query: 'test' }, { signal: signal(), toolCallId: 'search-test' })).toMatchObject({ results: [row] })
  })
})

describe('configuration and settings API', () => {
  it('rejects invalid config and ignores workspace search settings', async () => {
    expect(() => parseWebSearchConfig({ provider: 'custom' })).toThrow('WEB_SEARCH_URL_REQUIRED')
    expect(() => parseWebSearchConfig({ provider: 'custom', baseURL: 'file:///tmp/search' })).toThrow('WEB_SEARCH_URL_INVALID')
    expect(() => parseWebSearchConfig({ provider: 'custom', baseURL: 'http://user:secret@localhost/' })).toThrow('WEB_SEARCH_URL_INVALID')
    expect(() => parseWebSearchConfig({ provider: 'custom', baseURL: 'http://localhost', token: 'inline' })).toThrow('WEB_SEARCH_CONFIG_INVALID')
    expect(sanitizeWorkspaceConfig({ webSearch: { provider: 'custom', baseURL: 'http://localhost' } }).webSearch).toBeUndefined()
    vi.stubEnv('OPENAI_API_KEY', 'unrelated-key')
    expect(await resolveWebSearchOptions({ provider: 'duckduckgo' }, '/unused/config.json')).not.toHaveProperty('apiKey')
  })
  it('keeps workspace endpoints out even with --trust-workspace, while allowing explicit user config', async () => {
    const { root, path } = await workspace()
    vi.stubEnv('PULSE_HOME', join(root, 'home'))
    vi.stubEnv('PULSE_CONFIG', '')
    await mkdir(join(root, '.pulse'))
    const workspacePath = join(root, '.pulse/config.json')
    await writeFile(workspacePath, JSON.stringify({ webSearch: { provider: 'custom', baseURL: 'http://localhost:1234' } }))
    expect((await loadPulseConfig(root, undefined, true)).value.webSearch).toBeUndefined()
    await writeFile(path, JSON.stringify({ webSearch: { provider: 'searxng', baseURL: 'http://localhost:8888' } }))
    expect((await loadPulseConfig(root, path, true)).value.webSearch).toMatchObject({ provider: 'searxng' })
  })
  it('resolves search credentials through CLI host options', async () => {
    const { path } = await workspace()
    const ref = await new ProviderCredentialStore(path).add('search-only')
    const config = { providers: { mock: { provider: 'mock', models: { mock: { modelCode: 'mock' } } } }, activeModel: 'mock/mock', webSearch: { provider: 'custom', baseURL: 'http://localhost:8080/search', credentialRef: ref } }
    await writeFile(path, JSON.stringify(config))
    const options = await hostOptions(parse(['--config', path]))
    expect(options.webSearch).toMatchObject({ apiKey: 'search-only', credentialRef: ref })
  })
  it('tests a draft without saving, stores tokens separately, retains/clears credentials and enforces local-admin and origin checks', async () => {
    const { root, path } = await workspace()
    let auth: string | undefined
    const service = await http((req, res) => { auth = req.headers.authorization; json(res, { results: [row] }) })
    await writeFile(path, JSON.stringify({ allowNetwork: false }))
    const prepare = async (file: string) => {
      const config = JSON.parse(await readFile(file, 'utf8'))
      const search = await resolveWebSearchOptions(config.webSearch, path)
      return { cwd: root, dataDir: root, allowNetwork: config.allowNetwork === true, ...(search ? { webSearch: search } : {}) }
    }
    const host = createLocalHost({ cwd: root, dataDir: root })
    const server = new H5Server(host, { dataDir: root, host: '127.0.0.1', port: 0, configuration: { path, prepare } })
    closers.push(() => host.close()); closers.push(() => server.stop())
    const base = `http://127.0.0.1:${(await server.start()).port}`
    const session = await fetch(base + '/api/session/local', { method: 'POST', headers: { Origin: base } })
    const headers = { Origin: base, Cookie: session.headers.get('set-cookie')!, 'Content-Type': 'application/json' }
    let envelope = await (await fetch(base + '/api/config', { headers })).json()
    const config = { ...envelope.config, allowNetwork: true, webSearch: { provider: 'custom', baseURL: service.url + '/search', token: 'settings-private-token' } }
    const request = { method: 'POST', headers, body: JSON.stringify({ config, query: 'test' }) }
    expect((await fetch(base + '/api/config/web-search/test', { ...request, headers: { ...headers, Origin: 'https://untrusted.example' } })).status).toBe(403)
    expect((await fetch(base + '/api/config/web-search/test', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: request.body })).status).toBe(401)
    const tested = await fetch(base + '/api/config/web-search/test', request)
    expect(tested.status).toBe(200); expect((await tested.json()).results).toEqual([row]); expect(auth).toBe('Bearer settings-private-token')
    expect(await readFile(path, 'utf8')).toBe('{"allowNetwork":false}')
    expect(await readdir(root)).not.toContain('provider-credentials.json')
    const validation = await fetch(base + '/api/config/validate', { ...request, body: JSON.stringify({ config }) })
    expect(validation.status).toBe(200)
    const save = await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify({ version: envelope.version, config }) })
    expect(save.status).toBe(200)
    envelope = await save.json()
    expect(JSON.stringify(envelope)).not.toContain('settings-private-token')
    expect(envelope.config.webSearch.credentialRef).toMatch(/^credential-/)
    expect(await readFile(path, 'utf8')).not.toContain('settings-private-token')
    expect(await readFile(path + '.bak', 'utf8')).not.toContain('settings-private-token')
    const savedTest = await fetch(base + '/api/config/web-search/test', { ...request, body: JSON.stringify({ config: envelope.config }) })
    expect(savedTest.status).toBe(200); expect(auth).toBe('Bearer settings-private-token')
    const oldRef = envelope.config.webSearch.credentialRef
    const retained = await (await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify({ version: envelope.version, config: envelope.config }) })).json()
    expect(retained.config.webSearch.credentialRef).toBe(oldRef)
    retained.config.webSearch.token = ''
    const cleared = await (await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify({ version: retained.version, config: retained.config }) })).json()
    expect(cleared.config.webSearch.credentialRef).toBeUndefined()
    expect(await new ProviderCredentialStore(path).get(oldRef)).toBe('settings-private-token') // backups and active runs retain immutable credentials
    const disabled = await fetch(base + '/api/config/web-search/test', { ...request, body: JSON.stringify({ config: { ...config, allowNetwork: false } }) })
    expect(await disabled.json()).toMatchObject({ error: 'WEB_SEARCH_NETWORK_DISABLED' })
  })
  it.each([true, false])('calls the real search service from a host run (assistant=%s), using live configuration for the next tool call', async assistantChat => {
    const { root } = await workspace()
    let firstCalls = 0, secondCalls = 0
    const first = await http((_req, res) => { firstCalls++; json(res, { results: [row] }) })
    const second = await http((_req, res) => { secondCalls++; json(res, { results: [] }) })
    const options = { ...mockAssistant, cwd: root, dataDir: join(root, 'data'), taskController: false, allowNetwork: true, networkHosts: [], approvalMode: 'auto' as const, webSearch: { provider: 'custom' as const, baseURL: first.url }, mockToolCalls: [{ name: 'web.search', input: { query: 'test' } }], mockAfterToolResponse: 'Search completed.' }
    const host = createLocalHost(options); closers.push(() => host.close())
    const conversation = await host.createConversation()
    const run = await host.sendMessage(conversation.id, { text: 'Search the web for test.', assistantChat })
    host.applyLiveOptions({ ...options, webSearch: { provider: 'custom', baseURL: second.url } })
    for await (const _event of run.events) { /* drive actual runtime and HTTP tools */ }
    expect((await run.outcome()).status).toBe('succeeded')
    expect(firstCalls).toBe(0); expect(secondCalls).toBe(1)
    const next = await host.sendMessage(conversation.id, { text: 'Search again.', assistantChat })
    for await (const _event of next.events) { /* drive */ }
    expect((await next.outcome()).status).toBe('succeeded'); expect(secondCalls).toBe(2)
  })
  it('does not expose search tools with network disabled', async () => {
    const { root } = await workspace(); let calls = 0
    const service = await http((_req, res) => { calls++; json(res, { results: [] }) })
    const host = createLocalHost({ ...mockAssistant, cwd: root, dataDir: root, allowNetwork: false, taskController: false, webSearch: { provider: 'custom', baseURL: service.url }, mockToolCalls: [{ name: 'web.search', input: { query: 'test' } }], mockAfterToolResponse: 'done' }); closers.push(() => host.close())
    const c = await host.createConversation(); const run = await host.sendMessage(c.id, { text: 'Search test.', assistantChat: true })
    for await (const _event of run.events) { /* drive */ }
    await run.outcome(); expect(calls).toBe(0)
  })
})
