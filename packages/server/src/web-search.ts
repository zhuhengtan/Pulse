import { z } from 'zod'
import { defineTool } from '@hunterzhu/pulse-tool-sdk'
import { publicUrl } from './security.js'
import { parseSearchResults, readPublicPage } from './web.js'
import { resolveProviderApiKey } from './providers/credentials.js'

const configSchema = z.object({
  provider: z.enum(['duckduckgo', 'searxng', 'custom']),
  baseURL: z.string().min(1).max(2000).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  credentialRef: z.string().regex(/^credential-[a-f0-9-]{36}$/).optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
}).strict()

export interface WebSearchConfig { provider: 'duckduckgo' | 'searxng' | 'custom'; baseURL?: string; timeoutMs?: number; credentialRef?: string; apiKeyEnv?: string }
/** Resolved only by the trusted host; never serialize apiKey into user config. */
export interface WebSearchOptions extends WebSearchConfig { apiKey?: string }
export type WebSearchResult = { query: string; results: Array<{ title: string; url: string; snippet: string }>; fetchedAt: string }

export function parseWebSearchConfig(value: unknown): WebSearchConfig | undefined {
  if (value === undefined) return undefined
  const result = configSchema.safeParse(value)
  if (!result.success) throw new Error('WEB_SEARCH_CONFIG_INVALID')
  const config = result.data
  if (config.provider !== 'duckduckgo' && !config.baseURL) throw new Error('WEB_SEARCH_URL_REQUIRED')
  if (config.baseURL) searchServiceUrl(config.baseURL)
  return config as WebSearchConfig
}

function searchServiceUrl(raw: string): URL {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error()
    return url
  } catch { throw new Error('WEB_SEARCH_URL_INVALID') }
}

export async function resolveWebSearchOptions(value: unknown, configPath: string): Promise<WebSearchOptions | undefined> {
  const config = parseWebSearchConfig(value)
  if (!config) return undefined
  const apiKey = config.credentialRef || config.apiKeyEnv ? await resolveProviderApiKey({ ...config, provider: 'web-search' }, configPath) : undefined
  if (config.apiKeyEnv && !apiKey) throw new Error('WEB_SEARCH_CREDENTIAL_MISSING')
  return { ...config, ...(apiKey ? { apiKey } : {}) }
}

function normalizeResults(value: unknown, provider: WebSearchConfig['provider'], limit: number): WebSearchResult['results'] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { results?: unknown }).results)) throw new Error('WEB_SEARCH_PROTOCOL_ERROR')
  const results: WebSearchResult['results'] = []
  const seen = new Set<string>()
  for (const item of (value as { results: unknown[] }).results) {
    if (!item || typeof item !== 'object') throw new Error('WEB_SEARCH_PROTOCOL_ERROR')
    const row = item as Record<string, unknown>
    const snippet = provider === 'searxng' ? row.content ?? '' : row.snippet
    if (typeof row.title !== 'string' || typeof row.url !== 'string' || typeof snippet !== 'string') throw new Error('WEB_SEARCH_PROTOCOL_ERROR')
    let url: URL
    try { url = publicUrl(row.url); if (url.username || url.password) continue } catch { continue }
    if (!seen.has(url.toString()) && results.length < limit) {
      seen.add(url.toString())
      results.push({ title: row.title.slice(0, 500), url: url.toString(), snippet: snippet.slice(0, 4000) })
    }
  }
  return results
}

/** Configured endpoints are explicit host grants, including loopback/LAN. No redirects or arbitrary model-supplied endpoints. */
export async function searchWeb(query: string, limit = 5, signal: AbortSignal, options?: WebSearchOptions): Promise<WebSearchResult> {
  if (!query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('WEB_SEARCH_INPUT_INVALID')
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('WEB_SEARCH_CANCELLED'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error('WEB_SEARCH_TIMEOUT')), options?.timeoutMs ?? 12_000)
  let removeAbort = () => {}
  try {
    const cancelled = new Promise<never>((_, reject) => {
      const listener = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', listener, { once: true })
      removeAbort = () => controller.signal.removeEventListener('abort', listener)
      if (controller.signal.aborted) listener()
    })
    const request = async (): Promise<WebSearchResult> => {
      // Preserve the old environment endpoint's public-network/host restrictions.
      if (!options) {
        const endpoint = publicUrl(process.env.PULSE_SEARCH_URL ?? 'https://html.duckduckgo.com/html/')
        endpoint.searchParams.set('q', query)
        const page = await readPublicPage(endpoint.toString(), controller.signal, ['html.duckduckgo.com'], 12_000)
        return { query, results: normalizeResults({ results: parseSearchResults(page.source, limit) }, 'custom', limit), fetchedAt: new Date().toISOString() }
      }
      const endpoint = searchServiceUrl(options.baseURL ?? 'https://html.duckduckgo.com/html/')
      const headers: Record<string, string> = { accept: options.provider === 'duckduckgo' ? 'text/html' : 'application/json' }
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
      let body: string | undefined
      if (options.provider === 'custom') {
        headers['content-type'] = 'application/json'
        body = JSON.stringify({ query, limit })
      } else {
        if (options.provider === 'searxng') {
          if (!/\/search\/?$/.test(endpoint.pathname)) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/search`
          endpoint.searchParams.set('format', 'json')
        }
        endpoint.searchParams.set('q', query)
      }
      const response = await fetch(endpoint, { method: body ? 'POST' : 'GET', headers, ...(body ? { body } : {}), signal: controller.signal, redirect: 'manual' })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status >= 300 && response.status < 400) throw new Error('WEB_SEARCH_REDIRECT_BLOCKED')
        throw new Error(response.status === 401 || response.status === 403 ? `WEB_SEARCH_AUTH_${response.status}` : `WEB_SEARCH_HTTP_${response.status}`)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('WEB_SEARCH_PROTOCOL_ERROR')
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 1_000_000) { await reader.cancel(); throw new Error('WEB_SEARCH_RESPONSE_TOO_LARGE') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const text = Buffer.concat(chunks).toString('utf8')
      let results: WebSearchResult['results']
      if (options.provider === 'duckduckgo') results = normalizeResults({ results: parseSearchResults(text, limit) }, 'custom', limit)
      else {
        let decoded: unknown
        try { decoded = JSON.parse(text) } catch { throw new Error('WEB_SEARCH_PROTOCOL_ERROR') }
        results = normalizeResults(decoded, options.provider, limit)
      }
      return { query, results, fetchedAt: new Date().toISOString() }
    }
    return await Promise.race([request(), cancelled])
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    // Do not expose fetch errors, URLs, headers or provider bodies that may echo credentials.
    if (error instanceof Error && /^(WEB_SEARCH_|SEARCH_PROVIDER_|PRIVATE_NETWORK_|NETWORK_HOST_|URL_SCHEME_)/.test(error.message)) throw error
    throw new Error('WEB_SEARCH_NETWORK_ERROR')
  } finally { clearTimeout(timer); removeAbort(); signal.removeEventListener('abort', abort) }
}

export function createWebSearchTool(options?: WebSearchOptions) {
  const captured = options ? { ...options } : undefined
  return defineTool({
    name: 'web.search', description: 'Search public web pages using the host-configured search service. Results contain titles, source URLs and snippets; use web.fetch to read a source.', tags: ['web', 'research'],
    input: z.object({ query: z.string().min(1).max(500), limit: z.number().int().positive().max(10).default(5) }),
    output: z.object({ query: z.string(), results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })), fetchedAt: z.string() }),
    sideEffectPolicy: 'read', retrySafety: 'read_only', defaultTimeoutMs: (captured?.timeoutMs ?? 12_000) + 1000,
    // Configured services have an exact endpoint grant; do not add their host to the general network allow-list.
    permissions: captured ? {} : { networkHosts: ['html.duckduckgo.com'] },
    execute: ({ query, limit }, context) => searchWeb(query, limit, context.signal, captured), summarize: output => output,
  })
}
