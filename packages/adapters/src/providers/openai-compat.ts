import type { JsonValue, LLMRequestProjection, LLMResult } from '@hunterzhu/pulse-runtime'
import { consumeProviderSse, normalizeOpenAIResponse, parseProviderJson, providerHttpErrorFromResponse, providerNetworkError } from './normalize.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'
import { adaptCanonicalRequest, DynamicCapabilityProbe, lowerProjectionToCanonical, parseOpenAISseEvents, resolveModelCapability, toOpenAIPayload } from './canonical/index.js'

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name = 'OpenAI Compatible'
  private readonly baseURL: string
  private readonly probe = new DynamicCapabilityProbe()
  constructor(readonly id: string, private readonly config: ProviderPresetConfig) { this.baseURL = config.baseURL ?? 'https://api.openai.com/v1' }
  async executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; onObservation?: (chunk: string) => void; model?: string; outputSchema?: JsonValue; maxOutputTokens?: number }): Promise<LLMResult> {
    const streaming = params.onObservation !== undefined
    const { canonical, toolNameAliases } = lowerProjectionToCanonical({
      request: params.request,
      model: params.model ?? this.config.defaultModel,
      outputSchema: params.outputSchema,
      maxOutputTokens: params.maxOutputTokens ?? this.config.maxOutputTokens,
      reasoningEffort: this.config.reasoningEffort,
      toolChoice: this.config.toolChoice,
      stream: streaming,
    })

    const capability = resolveModelCapability(canonical.model, this.config.provider)
    const { request: adapted } = adaptCanonicalRequest(canonical, capability, this.probe, toolNameAliases)
    const sentReasoning = Boolean(adapted.reasoning?.effort)
    const body = toOpenAIPayload(adapted, capability, this.config.provider)

    try {
      const response = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...(this.config.extraHeaders ?? {}) }, body: JSON.stringify(body) })
      if (!response.ok) throw await providerHttpErrorFromResponse(response)
      if (!streaming || !response.headers.get('content-type')?.includes('text/event-stream')) return normalizeOpenAIResponse(await parseProviderJson(response), toolNameAliases, this.config.provider)
      const events = await consumeProviderSse(response, (event) => {
        const streamEvents = parseOpenAISseEvents(event.data)
        for (const ev of streamEvents) {
          if (ev.type === 'text_delta') params.onObservation?.(ev.text)
          if (ev.type === 'refusal_delta') params.onObservation?.(ev.refusal)
        }
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
      if (sentReasoning && this.probe.reasoningParameterRejected(cause)) {
        this.probe.markReasoningUnsupported(this.config.provider, canonical.model)
        return this.executeAttempt(params)
      }
      if (cause instanceof Error && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string' && 'retryable' in cause && typeof (cause as { retryable?: unknown }).retryable === 'boolean') throw cause
      throw providerNetworkError(cause)
    }
  }
}

export function toOpenAIMessages(request: LLMRequestProjection, provider = 'openai'): Array<Record<string, unknown>> {
  const { canonical } = lowerProjectionToCanonical({ request })
  const payload = toOpenAIPayload(canonical, resolveModelCapability(canonical.model, provider), provider)
  return Array.isArray(payload.messages) ? payload.messages as Array<Record<string, unknown>> : []
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
