import { createHash } from 'node:crypto'
import { createProviderAdapter } from '@hunterzhu/pulse-adapters'
import type { JsonValue, LLMRequestProjection, ProviderHistoryMessage } from '@hunterzhu/pulse-runtime'
import type { ProviderDefinition, ModelDefinition } from '../model-config.js'
import { resolveProviderVariant } from './catalog.js'
import { resolveProviderApiKey } from './credentials.js'
import type { CapabilityStatus, DiscoveredModel, ProviderConnectionInput, ProviderDiscovery, ProviderProbe } from './types.js'

function object(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {} }
function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined }
function capability(value: unknown): CapabilityStatus { return value === true || value === 'supported' ? 'supported' : value === false || value === 'unsupported' ? 'unsupported' : 'unknown' }
export function providerErrorCode(error: unknown): string {
  const code = object(error).code
  if (typeof code === 'string' && /^(?:PROVIDER|INVALID_TOOL|NETWORK|HTTP|ECONN|ENOTFOUND|ETIMEDOUT)[A-Z0-9_]*$/.test(code)) return code
  const message = error instanceof Error ? error.message : ''
  return /^(?:PROVIDER|CONFIG|MODEL)_[A-Z0-9_]+$/.test(message) ? message : 'PROVIDER_REQUEST_FAILED'
}
export function normalizeDiscoveredModel(raw: unknown): DiscoveredModel | undefined {
  const item = object(raw), id = item.id ?? item.modelCode
  if (typeof id !== 'string' || !id.trim() || id.length > 250 || /[\x00-\x1f]/.test(id)) return undefined
  const architecture = object(item.architecture), caps = object(item.capabilities)
  const modalities = architecture.output_modalities ?? item.output_modalities
  if (Array.isArray(modalities) && !modalities.includes('text')) return undefined
  const type = String(item.sub_type ?? item.type ?? item.task ?? '').toLowerCase()
  if (/embedding|rerank|image|audio|video|speech|transcri|tts/.test(type) && !/chat|text-generation/.test(type)) return undefined
  if (/embed|rerank/i.test(id) || !(Array.isArray(modalities) && modalities.includes('text')) && /whisper|tts|dall-e|gpt-image|imagen|veo-|sora-|audio|speech|transcri/i.test(id)) return undefined
  const context = positive(item.context_length ?? item.context_window ?? item.maxContextTokens)
  const output = positive(object(item.top_provider).max_completion_tokens ?? item.max_output_tokens ?? item.maxOutputTokens)
  const params = item.supported_parameters
  const inputModalities = architecture.input_modalities ?? item.input_modalities
  const imageInput = Array.isArray(inputModalities) ? inputModalities.includes('image') ? 'supported' : 'unsupported' : capability(item.imageInput ?? object(caps.vision).supported)
  return { modelCode: id.trim(), displayName: String(item.name ?? item.display_name ?? item.displayName ?? id).slice(0, 250), imageInput,
    ...(item.remote === true ? { remote: true } : {}),
    tools: Array.isArray(params) ? params.includes('tools') ? 'supported' : 'unsupported' : capability(item.tools ?? object(caps.tool_use).supported),
    structuredOutput: Array.isArray(params) ? params.includes('response_format') || params.includes('structured_outputs') ? 'supported' : 'unsupported' : capability(item.structuredOutput),
    ...(context ? { maxContextTokens: context } : {}), ...(output ? { maxOutputTokens: output } : {}) }
}

export class ProviderOnboarding {
  private readonly probes = new Map<string, { time: number; result: ProviderProbe }>()
  constructor(private readonly configPath: string) {}
  async connection(input: ProviderConnectionInput, config: Record<string, any>): Promise<{ input: ProviderConnectionInput; provider: ProviderDefinition; apiKey: string; docsURL: string }> {
    if (typeof input.presetId !== 'string' || typeof input.connectionVariant !== 'string') throw new Error('PROVIDER_PRESET_INVALID')
    const { preset, variant } = resolveProviderVariant(input.presetId, input.connectionVariant)
    const existing = input.providerId ? config.providers?.[input.providerId] : undefined
    if (input.providerId && !existing) throw new Error('PROVIDER_NOT_FOUND')
    if (existing && (existing.presetId !== input.presetId || existing.connectionVariant !== input.connectionVariant)) throw new Error('PROVIDER_CONNECTION_MISMATCH')
    const baseURL = preset.id === 'custom' || variant.editableBaseURL ? input.baseURL ?? existing?.baseURL ?? variant.baseURL : variant.baseURL
    let url: URL
    try { url = new URL(baseURL ?? '') } catch { throw new Error('PROVIDER_ENDPOINT_INVALID') }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const privateRemote = preset.id === 'ollama' && variant.id === 'remote' && (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.hostname.endsWith('.local') || /^\[f[cd][0-9a-f]/i.test(url.hostname))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.protocol === 'http:' && !loopback && !privateRemote || variant.loopbackOnly && !loopback) throw new Error('PROVIDER_ENDPOINT_INVALID')
    if (variant.discovery === 'ollama') {
      url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:api|v1)$/, '') + '/v1'
    }
    const apiKey = variant.auth === 'none' ? '' : (input.apiKey !== undefined ? input.apiKey.trim() : existing ? await resolveProviderApiKey(existing, this.configPath) : undefined) ?? ''
    if ((!apiKey && (variant.auth ?? 'required') === 'required') || apiKey.length > 16384 || /[\r\n\0]/.test(apiKey)) throw new Error('PROVIDER_CREDENTIAL_MISSING')
    return { input, provider: { provider: variant.provider, presetId: preset.id, connectionVariant: variant.id, name: input.name?.trim().slice(0, 100) || existing?.name || preset.name, baseURL: url.href.replace(/\/$/, '') }, apiKey, docsURL: preset.docsURL }
  }
  async discover(input: ProviderConnectionInput, config: Record<string, any>): Promise<ProviderDiscovery> {
    const connection = await this.connection(input, config)
    const { preset, variant } = resolveProviderVariant(input.presetId, input.connectionVariant)
    if (variant.discovery === 'catalog') return { models: structuredClone(variant.catalog ?? []), source: 'catalog', sourceURL: preset.docsURL, catalogVersion: preset.catalogVersion, authenticated: false }
    const models = new Map<string, DiscoveredModel>()
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const url = new URL(variant.discovery === 'ollama' ? `${connection.provider.baseURL!.replace(/\/v1$/, '')}/api/tags` : `${connection.provider.baseURL}${variant.discovery === 'anthropic' ? '/v1/models' : '/models'}`)
      if (preset.id === 'siliconflow') url.searchParams.set('sub_type', 'chat')
      if (variant.discovery === 'anthropic') { url.searchParams.set('limit', '1000'); if (cursor) url.searchParams.set('after_id', cursor) }
      if (preset.id === 'openrouter') { url.searchParams.set('limit', '1000'); url.searchParams.set('offset', String(page * 1000)) }
      let response: Response
      try { response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error', headers: variant.discovery === 'anthropic' ? { 'x-api-key': connection.apiKey, 'anthropic-version': '2023-06-01' } : connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {} }) }
      catch { throw new Error('PROVIDER_NETWORK_ERROR') }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`PROVIDER_HTTP_${response.status}`) }
      const body = await this.readJson(response)
      const rows = variant.discovery === 'ollama' ? body.models : body.data
      if (!Array.isArray(rows)) throw new Error('PROVIDER_MODEL_LIST_INVALID')
      for (const raw of rows) {
        const record = object(raw)
        const cloudModel = Boolean(record.remote_host || record.remote_model) || /(?:-cloud|:cloud)$/.test(String(record.model ?? record.name))
        const item = normalizeDiscoveredModel(variant.discovery === 'ollama' ? { ...record, id: record.model ?? record.name, remote: variant.id !== 'local' || cloudModel, ...(variant.id === 'cloud' || cloudModel ? { structuredOutput: 'unsupported' } : {}) } : raw)
        if (item) models.set(item.modelCode, item)
      }
      if (models.size > 10000) throw new Error('PROVIDER_MODEL_LIST_TOO_LARGE')
      if (variant.discovery === 'anthropic' && body.has_more) {
        if (typeof body.last_id !== 'string' || seen.has(body.last_id)) throw new Error('PROVIDER_MODEL_PAGINATION_INVALID')
        cursor = body.last_id; seen.add(cursor); continue
      }
      if (preset.id === 'openrouter' && body.data.length === 1000) continue
      return { models: [...models.values()], source: 'remote', sourceURL: preset.docsURL, catalogVersion: preset.catalogVersion, authenticated: !['custom', 'openrouter', 'ollama'].includes(preset.id) }
    }
    throw new Error('PROVIDER_MODEL_PAGINATION_LIMIT')
  }
  private async readJson(response: Response): Promise<Record<string, any>> {
    if (!response.body) throw new Error('PROVIDER_MODEL_LIST_INVALID')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 8 * 1024 * 1024) throw new Error('PROVIDER_MODEL_LIST_TOO_LARGE'); chunks.push(next.value) }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PROVIDER_MODEL_LIST_INVALID')
      return value as Record<string, any>
    } catch (error) { if (error instanceof Error && error.message === 'PROVIDER_MODEL_LIST_TOO_LARGE') throw error; throw new Error('PROVIDER_MODEL_LIST_INVALID') }
    finally { await reader.cancel().catch(() => undefined) }
  }
  private probeKey(provider: ProviderDefinition, apiKey: string, modelCode: string): string { return createHash('sha256').update(JSON.stringify([provider.provider, provider.baseURL, apiKey, modelCode])).digest('hex') }
  async probe(input: ProviderConnectionInput, config: Record<string, any>): Promise<ProviderProbe> {
    const { provider, apiKey } = await this.connection(input, config)
    const modelCode = input.modelCode
    if (!modelCode || modelCode.length > 250 || /[\x00-\x1f]/.test(modelCode)) throw new Error('PROVIDER_MODEL_REQUIRED')
    const result: ProviderProbe = { modelCode, chat: { status: 'skipped' }, tools: { status: 'skipped' }, structuredOutput: { status: 'skipped' } }
    const savedModel = Object.values(object(config.providers?.[input.providerId ?? '']).models ?? {}).find((item: any) => item.modelCode === modelCode) as ModelDefinition | undefined
    const profile = { provider: provider.provider, baseURL: provider.baseURL!, apiKey, defaultModel: modelCode, maxOutputTokens: 1024, ...(['ollama', 'ollama-cloud', 'ollama-remote'].includes(provider.provider) ? { reasoningEffort: 'none' as const } : {}), ...(input.remote === true || savedModel?.remote === true ? { remote: true } : {}), ...(input.structuredOutput === 'unsupported' || savedModel?.structuredOutput === 'unsupported' ? { capabilityProfile: { structuredOutput: 'unsupported' as const } } : {}) }
    const makeRequest = (instruction: string, history?: ProviderHistoryMessage[], tools = false): LLMRequestProjection => ({
      contextSpec: { globalSnapshotVersion: 0, laneSnapshotVersion: 0, resultRefs: [], eventIds: [], toolSetId: 'provider-probe', instruction, privacy: 'public', privacyRefs: [], ...(history ? { providerHistory: history } : {}) },
      blocks: [{ kind: 'system', content: 'Connection check. Follow the exact instructions. Do not use external services.' }, ...(tools ? [{ kind: 'tools' as const, content: [{ name: 'pulse_echo', description: 'Return its value unchanged.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] }] : []), ...(history ? [{ kind: 'provider_history' as const, content: [] }] : []), { kind: 'instruction', content: instruction }], prefixHash: 'probe', projectionHash: 'probe', builderVersion: '1', policyVersion: '1', toolSetVersion: 'provider-probe', privacy: 'public', privacyRefs: [],
    })
    let streamObserved = false
    let attempts = 0
    const admit = () => { if (attempts >= 3) throw new Error('PROVIDER_PROBE_BUDGET_EXHAUSTED'); attempts++ }
    const call = (request: LLMRequestProjection, toolChoice?: 'auto', outputSchema?: JsonValue) => {
      admit()
      return createProviderAdapter({ ...profile, ...(toolChoice ? { toolChoice } : {}) }).executeAttempt({ request, signal: AbortSignal.timeout(25000), beforeRetryAttempt: async () => { admit() }, onObservation: chunk => { if (chunk) streamObserved = true }, ...(outputSchema ? { outputSchema } : {}) })
    }
    try {
      const chat = await call(makeRequest('Reply exactly PULSE_OK.'))
      if (chat.finishReason !== 'stop' || !chat.text.includes('PULSE_OK')) throw new Error('PROVIDER_CHAT_RESPONSE_INVALID')
      if (!streamObserved) throw new Error('PROVIDER_STREAM_UNAVAILABLE')
      result.chat = { status: 'passed' }
    } catch (error) { result.chat = { status: 'failed', code: providerErrorCode(error) } }
    if (result.chat.status === 'passed') {
      try {
        const tool = await call(makeRequest('Call pulse_echo exactly once with value "PULSE_OK".', undefined, true), 'auto')
        const entry = tool.toolCalls[0]
        if (tool.finishReason !== 'tool_calls' || tool.toolCalls.length !== 1 || !entry || entry.name !== 'pulse_echo' || object(entry.input).value !== 'PULSE_OK') throw new Error('PROVIDER_TOOL_RESPONSE_INVALID')
        const history: ProviderHistoryMessage[] = [
          { role: 'user', content: 'Call pulse_echo with PULSE_OK, then return JSON {"ok":true}.' },
          { role: 'assistant', content: tool.text || null, continuationProvider: provider.provider, ...(tool.providerContinuation?.reasoningContent ? { reasoningContent: tool.providerContinuation.reasoningContent } : {}), ...(tool.providerContinuation?.metadata ? { providerMetadata: tool.providerContinuation.metadata } : {}), toolCalls: [{ id: entry.providerToolCallId ?? entry.toolCallId, name: entry.providerToolName ?? entry.name, arguments: entry.providerToolArguments ?? JSON.stringify(entry.input) }] },
          { role: 'tool', toolCallId: entry.providerToolCallId ?? entry.toolCallId, name: entry.providerToolName ?? entry.name, content: 'PULSE_OK', resultRef: 'provider-probe' },
        ]
        const final = await call(makeRequest('The tool returned PULSE_OK. Reply with JSON {"ok":true}.', history), undefined, { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false })
        if (final.finishReason !== 'stop' || !final.text.trim()) throw new Error('PROVIDER_TOOL_CONTINUATION_INVALID')
        result.tools = { status: 'passed' }
        const parsed = final.structured ?? (() => { try { return JSON.parse(final.text) } catch { return undefined } })()
        result.structuredOutput = object(parsed).ok === true ? { status: 'passed' } : { status: 'failed', code: 'PROVIDER_STRUCTURED_RESPONSE_INVALID' }
      } catch (error) { result.tools = { status: 'failed', code: providerErrorCode(error) }; result.structuredOutput = { status: 'skipped' } }
    }
    for (const [key, value] of this.probes) if (Date.now() - value.time > 10 * 60 * 1000) this.probes.delete(key)
    if (this.probes.size >= 100) this.probes.delete(this.probes.keys().next().value!)
    this.probes.set(this.probeKey(provider, apiKey, modelCode), { time: Date.now(), result })
    return result
  }
  verification(provider: ProviderDefinition, apiKey: string, modelCode: string): ProviderProbe | undefined {
    const value = this.probes.get(this.probeKey(provider, apiKey, modelCode))
    return value && Date.now() - value.time < 10 * 60 * 1000 ? value.result : undefined
  }
}

/** Refresh discovery fields only; user-editable values and referenced models survive. */
export function mergeDiscoveredModels(existing: Record<string, ModelDefinition>, models: DiscoveredModel[], verification?: ProviderProbe): Record<string, ModelDefinition> {
  const merged = structuredClone(existing)
  for (const model of models) {
    const priorId = Object.keys(merged).find(id => merged[id]!.modelCode === model.modelCode)
    const prior = priorId ? merged[priorId] : undefined
    const id = priorId ?? model.modelCode
    const next: ModelDefinition = { ...model, ...prior, discovery: model, ...(verification?.modelCode === model.modelCode ? { verification: { ...verification, checkedAt: new Date().toISOString() } } : {}) }
    if (prior?.discovery) for (const key of ['displayName', 'maxContextTokens', 'maxOutputTokens', 'imageInput', 'tools', 'structuredOutput'] as const) {
      if (prior[key] === prior.discovery[key]) {
        if (model[key] === undefined) delete next[key]
        else Object.assign(next, { [key]: model[key] })
      }
    }
    if (verification?.modelCode === model.modelCode) {
      if (verification.tools.status === 'passed') next.tools = 'supported'
      if (verification.structuredOutput.status === 'passed' && next.structuredOutput !== 'unsupported') next.structuredOutput = 'supported'
    }
    merged[id] = next
  }
  return merged
}
