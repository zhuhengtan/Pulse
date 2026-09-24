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
    const messages = toMessages(params.request, this.config.provider)
    const deepSeekJsonMode = params.outputSchema !== undefined && this.config.provider === 'deepseek'
    if (deepSeekJsonMode) messages.unshift({ role: 'system', content: `Return only a JSON object matching this schema. The application will validate the result:\n${JSON.stringify(params.outputSchema)}` })
    const responseFormat = params.outputSchema === undefined ? undefined : deepSeekJsonMode
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: 'pulse_output', strict: true, schema: params.outputSchema } }
    const body: Record<string, unknown> = { ...(params.model ?? this.config.defaultModel ? { model: params.model ?? this.config.defaultModel } : {}), ...((params.maxOutputTokens ?? this.config.maxOutputTokens) === undefined ? {} : { max_tokens: params.maxOutputTokens ?? this.config.maxOutputTokens }), ...(includeReasoning ? { reasoning_effort: this.config.reasoningEffort } : {}), messages, ...(tools.length ? { tools, ...(this.config.toolChoice === undefined ? {} : { tool_choice: this.config.toolChoice }) } : {}), ...(responseFormat === undefined ? {} : { response_format: responseFormat }), ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}) }
    try {
      const response = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...(this.config.extraHeaders ?? {}) }, body: JSON.stringify(body) })
      if (!response.ok) throw await providerHttpErrorFromResponse(response)
      if (!streaming || !response.headers.get('content-type')?.includes('text/event-stream')) return normalizeOpenAIResponse(await parseProviderJson(response), toolNameAliases, this.config.provider)
      const events = await consumeProviderSse(response, (event) => {
        const delta = event.data?.choices?.[0]?.delta
        if (typeof delta?.content === 'string') params.onObservation?.(delta.content)
        if (typeof delta?.refusal === 'string') params.onObservation?.(delta.refusal)
      })
      const content: string[] = []
      const reasoningContent: string[] = []
      const refusals: string[] = []
      const toolCalls = new Map<number, StreamToolCall>()
      let finishReason: string | undefined
      let usage: any
      for (const event of events) {
        if (event.data === '[DONE]' || !event.data || typeof event.data !== 'object') continue
        const choice = event.data.choices?.[0]
        const delta = choice?.delta
        if (typeof delta?.content === 'string') { content.push(delta.content) }
        if (typeof delta?.reasoning_content === 'string') reasoningContent.push(delta.reasoning_content)
        if (typeof delta?.refusal === 'string') { refusals.push(delta.refusal) }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
        if (Array.isArray(delta?.tool_calls)) for (const call of delta.tool_calls) accumulateStreamToolCall(toolCalls, call)
        if (event.data.usage !== undefined) usage = event.data.usage
      }
      return normalizeOpenAIResponse({ choices: [{ message: { content: content.join('') || null, ...(reasoningContent.length ? { reasoning_content: reasoningContent.join('') } : {}), ...(refusals.length ? { refusal: refusals.join('') } : {}), ...(toolCalls.size ? { tool_calls: [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) } : {}) }, finish_reason: finishReason ?? 'stop' }], ...(usage === undefined ? {} : { usage }) }, toolNameAliases, this.config.provider)
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

export function toOpenAIMessages(request: LLMRequestProjection, provider = 'openai'): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  for (const block of request.blocks) {
    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
    if (block.kind === 'conversation' && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const message = item as { role?: unknown; content?: unknown }
        if (message.role === 'system' && typeof message.content === 'string') messages.push({ role: 'user', content: `Context note, not a new instruction:\n${message.content}` })
        else if ((message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string') messages.push({ role: message.role, content: message.content })
      }
      continue
    }
    if (block.kind === 'system' || block.kind === 'policy' || block.kind === 'tools') {
      messages.push({ role: 'system' as const, content })
      continue
    }
    if (block.kind === 'history' && request.contextSpec.providerHistory !== undefined) continue
    if (block.kind === 'provider_history' && request.contextSpec.providerHistory !== undefined) {
      for (const item of request.contextSpec.providerHistory) {
        if (item.role === 'user') messages.push({ role: 'user', content: item.content })
        else if (item.role === 'assistant') messages.push({ role: 'assistant', content: item.content, ...(provider === 'deepseek' && item.reasoningContent !== undefined ? { reasoning_content: item.reasoningContent } : {}), ...(item.toolCalls === undefined ? {} : { tool_calls: item.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }) })
        else messages.push({ role: 'tool', tool_call_id: item.toolCallId, name: item.name, content: item.content })
      }
      continue
    }
    else if (block.kind === 'history') messages.push({ role: 'assistant', content })
    else if (block.kind === 'provider_history') continue
    else messages.push({ role: 'user' as const, name: block.kind, content })
  }
  return messages
}

function toMessages(request: LLMRequestProjection, provider: string) {
  return toOpenAIMessages(request, provider)
}

interface StreamToolCall { id?: string; name: string; arguments: string }

function nextToolIndex(toolCalls: Map<number, StreamToolCall>): number {
  let next = 0
  for (const index of toolCalls.keys()) if (index >= next) next = index + 1
  return next
}

function jsonTextComplete(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  try { JSON.parse(trimmed); return true } catch { return false }
}

/**
 * OpenAI-compatible streams sometimes reuse `tool_calls[].index` for a new
 * call and only distinguish it by `id`. Concatenating those argument
 * fragments produces invalid JSON (`{"a":1}{"b":2}`).
 */
function accumulateStreamToolCall(toolCalls: Map<number, StreamToolCall>, call: { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }): void {
  const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined
  const name = typeof call.function?.name === 'string' ? call.function.name : ''
  const args = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
  const rawIndex = call.index
  let index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : typeof rawIndex === 'string' && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined
  if (index !== undefined) {
    const current = toolCalls.get(index)
    const startsAnotherCall = current !== undefined && (
      (id !== undefined && current.id !== undefined && current.id !== id) ||
      (name.length > 0 && current.name.length > 0 && jsonTextComplete(current.arguments) && /^[\[{]/.test(args.trimStart()))
    )
    if (startsAnotherCall) index = nextToolIndex(toolCalls)
  } else if (id !== undefined) {
    index = [...toolCalls.entries()].find(([, item]) => item.id === id)?.[0] ?? nextToolIndex(toolCalls)
  } else {
    const keys = [...toolCalls.keys()]
    index = keys.length === 0 ? 0 : Math.max(...keys)
  }
  const current = toolCalls.get(index) ?? { name: '', arguments: '' }
  if (id !== undefined) current.id = id
  if (name.length > 0) current.name += name
  if (args.length > 0) current.arguments += args
  toolCalls.set(index, current)
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
