import type { JsonValue, LLMRequestProjection } from '@pulse/runtime'
import { normalizeOpenAIResponse } from './normalize.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name = 'OpenAI Compatible'
  private readonly baseURL: string
  constructor(readonly id: string, private readonly config: ProviderPresetConfig) { this.baseURL = config.baseURL ?? 'https://api.openai.com/v1' }
  async executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; onObservation?: (chunk: string) => void; model?: string; outputSchema?: JsonValue; maxOutputTokens?: number }) {
    const body: Record<string, unknown> = { ...(params.model ?? this.config.defaultModel ? { model: params.model ?? this.config.defaultModel } : {}), ...((params.maxOutputTokens ?? this.config.maxOutputTokens) === undefined ? {} : { max_tokens: params.maxOutputTokens ?? this.config.maxOutputTokens }), messages: toMessages(params.request), ...(toolDefinitions(params.request).length ? { tools: toolDefinitions(params.request) } : {}), ...(params.outputSchema === undefined ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'pulse_output', strict: true, schema: params.outputSchema } } }) }
    const response = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...(this.config.extraHeaders ?? {}) }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`)
    return normalizeOpenAIResponse(await response.json())
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
