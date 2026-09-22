import type { JsonValue, LLMRequestProjection, LLMResult } from '@hunterzhu/pulse-runtime'
import { consumeProviderSse, normalizeOpenAIResponse, parseProviderJson, providerHttpErrorFromResponse, providerNetworkError } from './normalize.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'
function reasoningParameterRejected(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  const code = (cause as { code?: unknown }).code
  if (code !== 'PROVIDER_HTTP_400') return false
  return /reasoning_effort|unknown parameter|unrecognized (?:request )?argument|extra fields? not permitted/i.test(cause.message)
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name = 'OpenAI Compatible'
  private readonly baseURL: string
  private reasoningUnsupported = false
  constructor(readonly id: string, private readonly config: ProviderPresetConfig) { this.baseURL = config.baseURL ?? 'https://api.openai.com/v1' }
  async executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; onObservation?: (chunk: string) => void; model?: string; outputSchema?: JsonValue; maxOutputTokens?: number }): Promise<LLMResult> {
    const streaming = params.onObservation !== undefined
    const { definitions: tools, aliases: toolNameAliases } = toolDefinitions(params.request)
    const includeReasoning = Boolean(this.config.reasoningEffort) && !this.reasoningUnsupported
    const body: Record<string, unknown> = { ...(params.model ?? this.config.defaultModel ? { model: params.model ?? this.config.defaultModel } : {}), ...((params.maxOutputTokens ?? this.config.maxOutputTokens) === undefined ? {} : { max_tokens: params.maxOutputTokens ?? this.config.maxOutputTokens }), ...(includeReasoning ? { reasoning_effort: this.config.reasoningEffort } : {}), messages: toMessages(params.request), ...(tools.length ? { tools, ...(this.config.toolChoice === undefined ? {} : { tool_choice: this.config.toolChoice }) } : {}), ...(params.outputSchema === undefined ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'pulse_output', strict: true, schema: params.outputSchema } } }), ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}) }
    try {
      const response = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...(this.config.extraHeaders ?? {}) }, body: JSON.stringify(body) })
      if (!response.ok) throw await providerHttpErrorFromResponse(response)
      if (!streaming || !response.headers.get('content-type')?.includes('text/event-stream')) return normalizeOpenAIResponse(await parseProviderJson(response), toolNameAliases)
      const events = await consumeProviderSse(response)
      const content: string[] = []
      const refusals: string[] = []
      const toolCalls = new Map<number, { id?: string; name: string; arguments: string }>()
      let finishReason: string | undefined
      let usage: any
      for (const event of events) {
        if (event.data === '[DONE]' || !event.data || typeof event.data !== 'object') continue
        const choice = event.data.choices?.[0]
        const delta = choice?.delta
        if (typeof delta?.content === 'string') { content.push(delta.content); params.onObservation?.(delta.content) }
        if (typeof delta?.refusal === 'string') { refusals.push(delta.refusal); params.onObservation?.(delta.refusal) }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
        if (Array.isArray(delta?.tool_calls)) for (const call of delta.tool_calls) {
          const index = Number(call.index ?? 0)
          const current = toolCalls.get(index) ?? { name: '', arguments: '' }
          if (typeof call.id === 'string') current.id = call.id
          if (typeof call.function?.name === 'string') current.name += call.function.name
          if (typeof call.function?.arguments === 'string') current.arguments += call.function.arguments
          toolCalls.set(index, current)
        }
        if (event.data.usage !== undefined) usage = event.data.usage
      }
      return normalizeOpenAIResponse({ choices: [{ message: { content: content.join('') || null, ...(refusals.length ? { refusal: refusals.join('') } : {}), ...(toolCalls.size ? { tool_calls: [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) } : {}) }, finish_reason: finishReason ?? 'stop' }], ...(usage === undefined ? {} : { usage }) }, toolNameAliases)
    } catch (cause) {
      if (params.signal.aborted) throw Object.assign(new Error('Provider request was cancelled.'), { code: 'PROVIDER_REQUEST_CANCELLED', retryable: false, cause })
      if (includeReasoning && reasoningParameterRejected(cause)) {
        this.reasoningUnsupported = true
        return this.executeAttempt(params)
      }
      if (cause instanceof Error && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string' && 'retryable' in cause && typeof (cause as { retryable?: unknown }).retryable === 'boolean') throw cause
      throw providerNetworkError(cause)
    }
  }
}

export function toOpenAIMessages(request: LLMRequestProjection): Array<{ role: 'system' | 'user' | 'assistant'; content: string; name?: string }> {
  return request.blocks.map((block) => {
    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
    if (block.kind === 'system' || block.kind === 'policy' || block.kind === 'tools') return { role: 'system' as const, content }
    if (block.kind === 'history') return { role: 'assistant' as const, content }
    return { role: 'user' as const, name: block.kind, content }
  })
}

function toMessages(request: LLMRequestProjection) {
  return toOpenAIMessages(request)
}

function toolDefinitions(request: LLMRequestProjection): { definitions: Array<{ type: 'function'; function: { name: string; description?: string; parameters: JsonValue } }>; aliases: ReadonlyMap<string, string> } {
  const block = request.blocks.find((candidate) => candidate.kind === 'tools')
  const content = block?.content
  const values: JsonValue[] = Array.isArray(content) ? content : content && typeof content === 'object' && !Array.isArray(content) && Array.isArray((content as Record<string, JsonValue>).tools) ? (content as Record<string, JsonValue>).tools as JsonValue[] : []
  const aliases = new Map<string, string>()
  const used = new Set<string>()
  const definitions = values.filter((value): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.name === 'string').map((value, index) => {
    const originalName = value.name as string
    const baseName = originalName.replace(/[^a-zA-Z0-9_-]/g, '_') || `tool_${index + 1}`
    let providerName = baseName
    let suffix = 2
    while (used.has(providerName)) providerName = `${baseName}_${suffix++}`
    used.add(providerName)
    aliases.set(providerName, originalName)
    return { type: 'function' as const, function: { name: providerName, ...(typeof value.description === 'string' ? { description: value.description } : {}), parameters: (value.inputSchema ?? value.parameters ?? {}) as JsonValue } }
  })
  return { definitions, aliases }
}
