import type { JsonValue, LLMRequestProjection } from '@pulse/runtime'
import { consumeProviderSse, normalizeOpenAIResponse } from './normalize.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name = 'OpenAI Compatible'
  private readonly baseURL: string
  constructor(readonly id: string, private readonly config: ProviderPresetConfig) { this.baseURL = config.baseURL ?? 'https://api.openai.com/v1' }
  async executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; onObservation?: (chunk: string) => void; model?: string; outputSchema?: JsonValue; maxOutputTokens?: number }) {
    const streaming = params.onObservation !== undefined
    const body: Record<string, unknown> = { ...(params.model ?? this.config.defaultModel ? { model: params.model ?? this.config.defaultModel } : {}), ...((params.maxOutputTokens ?? this.config.maxOutputTokens) === undefined ? {} : { max_tokens: params.maxOutputTokens ?? this.config.maxOutputTokens }), messages: toMessages(params.request), ...(toolDefinitions(params.request).length ? { tools: toolDefinitions(params.request) } : {}), ...(params.outputSchema === undefined ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'pulse_output', strict: true, schema: params.outputSchema } } }), ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}) }
    const response = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...(this.config.extraHeaders ?? {}) }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`)
    if (!streaming || !response.headers.get('content-type')?.includes('text/event-stream')) return normalizeOpenAIResponse(await response.json())
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
    return normalizeOpenAIResponse({ choices: [{ message: { content: content.join('') || null, ...(refusals.length ? { refusal: refusals.join('') } : {}), ...(toolCalls.size ? { tool_calls: [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) } : {}) }, finish_reason: finishReason ?? 'stop' }], ...(usage === undefined ? {} : { usage }) })
  }
}

function toMessages(request: LLMRequestProjection): Array<{ role: 'system' | 'user'; content: string }> {
  return request.blocks.map((block) => ({ role: block.kind === 'system' || block.kind === 'policy' || block.kind === 'tools' ? 'system' : 'user', content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }))
}

function toolDefinitions(request: LLMRequestProjection): Array<{ type: 'function'; function: { name: string; description?: string; parameters: JsonValue } }> {
  const block = request.blocks.find((candidate) => candidate.kind === 'tools')
  const content = block?.content
  const values: JsonValue[] = Array.isArray(content) ? content : content && typeof content === 'object' && !Array.isArray(content) && Array.isArray((content as Record<string, JsonValue>).tools) ? (content as Record<string, JsonValue>).tools as JsonValue[] : []
  return values.filter((value): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.name === 'string').map((value) => ({ type: 'function', function: { name: value.name as string, ...(typeof value.description === 'string' ? { description: value.description } : {}), parameters: (value.inputSchema ?? value.parameters ?? {}) as JsonValue } }))
}
