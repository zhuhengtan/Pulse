import type { JsonValue, LLMRequestProjection } from '@pulse/runtime'
import { normalizeAnthropicResponse } from './normalize.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'
export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'Anthropic Messages'
  constructor(readonly id: string, private readonly config: ProviderPresetConfig) {}
  async executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; outputSchema?: JsonValue; model?: string }) {
    const system = params.request.blocks.filter((block) => block.kind === 'system' || block.kind === 'policy' || block.kind === 'tools').map((block) => typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).join('\n')
    const messages = [{ role: 'user', content: params.request.blocks.filter((block) => !['system', 'policy', 'tools'].includes(block.kind)).map((block) => ({ type: 'text', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) })) }]
    const body = { ...(params.model ?? this.config.defaultModel ? { model: params.model ?? this.config.defaultModel } : {}), max_tokens: 4096, ...(system ? { system } : {}), messages, ...(toolDefinitions(params.request).length ? { tools: toolDefinitions(params.request) } : {}), ...(params.outputSchema === undefined ? {} : { output_format: { type: 'json_schema', schema: params.outputSchema } }) }
    const response = await fetch(`${(this.config.baseURL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}), 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`)
    return normalizeAnthropicResponse(await response.json())
  }
}

function toolDefinitions(request: LLMRequestProjection): Array<{ name: string; description?: string; input_schema: JsonValue }> {
  const block = request.blocks.find((candidate) => candidate.kind === 'tools')
  const content = block?.content
  const values: JsonValue[] = Array.isArray(content) ? content : content && typeof content === 'object' && !Array.isArray(content) && Array.isArray((content as Record<string, JsonValue>).tools) ? (content as Record<string, JsonValue>).tools as JsonValue[] : []
  return values.filter((value): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.name === 'string').map((value) => ({ name: value.name as string, ...(typeof value.description === 'string' ? { description: value.description } : {}), input_schema: (value.inputSchema ?? value.parameters ?? {}) as JsonValue }))
}
