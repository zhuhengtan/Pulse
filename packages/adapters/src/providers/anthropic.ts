import type { JsonValue, LLMRequestProjection } from '@hunterzhu/pulse-runtime'
import { consumeProviderSse, normalizeAnthropicResponse, parseProviderJson, providerHttpErrorFromResponse, providerNetworkError, providerResponseError } from './normalize.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'

function anthropicThinking(effort: ProviderPresetConfig['reasoningEffort'], maxTokens: number): { thinking?: { type: 'enabled'; budget_tokens: number } } {
  if (!effort) return {}
  const requested = effort === 'high' ? 8_000 : effort === 'medium' ? 2_048 : 1_024
  const budget = Math.min(requested, maxTokens - 1_024)
  if (budget < 1_024 || budget >= maxTokens) return {}
  return { thinking: { type: 'enabled', budget_tokens: budget } }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'Anthropic Messages'
  constructor(readonly id: string, private readonly config: ProviderPresetConfig) {}
  async executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; onObservation?: (chunk: string) => void; outputSchema?: JsonValue; model?: string; maxOutputTokens?: number }) {
    const system = params.request.blocks.filter((block) => block.kind === 'system' || block.kind === 'policy' || block.kind === 'tools').map((block) => typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).join('\n')
    const messages = [{ role: 'user', content: params.request.blocks.filter((block) => !['system', 'policy', 'tools'].includes(block.kind)).map((block) => ({ type: 'text', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) })) }]
    const streaming = params.onObservation !== undefined
    const tools = toolDefinitions(params.request)
    const maxTokens = params.maxOutputTokens ?? this.config.maxOutputTokens ?? 4096
    const body = { ...(params.model ?? this.config.defaultModel ? { model: params.model ?? this.config.defaultModel } : {}), max_tokens: maxTokens, ...anthropicThinking(this.config.reasoningEffort, maxTokens), ...(system ? { system } : {}), messages, ...(tools.length ? { tools, ...(this.config.toolChoice === undefined ? {} : { tool_choice: anthropicToolChoice(this.config.toolChoice) }) } : {}), ...(params.outputSchema === undefined ? {} : { output_format: { type: 'json_schema', schema: params.outputSchema } }), ...(streaming ? { stream: true } : {}) }
    try {
      const response = await fetch(`${(this.config.baseURL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}), 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) })
      if (!response.ok) throw await providerHttpErrorFromResponse(response)
      if (!streaming || !response.headers.get('content-type')?.includes('text/event-stream')) return normalizeAnthropicResponse(await parseProviderJson(response))
      const events = await consumeProviderSse(response)
      const blocks: Array<Record<string, unknown>> = []
      let stopReason: string | undefined
      let usage: Record<string, unknown> = {}
      for (const event of events) {
        if (!event.data || typeof event.data !== 'object') continue
        const data = event.data
        if (event.event === 'message_start' && data.message?.usage && typeof data.message.usage === 'object') usage = { ...usage, ...data.message.usage }
        if (event.event === 'content_block_start' && data.content_block && typeof data.content_block === 'object') blocks[Number(data.index ?? blocks.length)] = { ...data.content_block }
        if (event.event === 'content_block_delta' && data.delta && typeof data.delta === 'object') {
          const index = Number(data.index ?? 0)
          const block = blocks[index] ?? {}
          if (data.delta.type === 'text_delta' && typeof data.delta.text === 'string') { block.type = 'text'; block.text = `${typeof block.text === 'string' ? block.text : ''}${data.delta.text}`; params.onObservation?.(data.delta.text) }
          if (data.delta.type === 'input_json_delta' && typeof data.delta.partial_json === 'string') block.inputJson = `${typeof block.inputJson === 'string' ? block.inputJson : ''}${data.delta.partial_json}`
          blocks[index] = block
        }
        if (event.event === 'message_delta') {
          if (typeof data.delta?.stop_reason === 'string') stopReason = data.delta.stop_reason
          if (data.usage && typeof data.usage === 'object') usage = { ...usage, ...data.usage }
        }
      }
      const content = blocks.filter(Boolean).map((block) => {
        if (block.type === 'tool_use' && typeof block.inputJson === 'string') {
          try { return { ...block, input: JSON.parse(block.inputJson) as unknown } }
          catch { throw providerResponseError('INVALID_TOOL_ARGUMENTS') }
        }
        return block
      })
      return normalizeAnthropicResponse({ content, stop_reason: stopReason, ...(Object.keys(usage).length ? { usage } : {}) })
    } catch (cause) {
      if (params.signal.aborted) throw Object.assign(new Error('Provider request was cancelled.'), { code: 'PROVIDER_REQUEST_CANCELLED', retryable: false, cause })
      if (cause instanceof Error && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string' && 'retryable' in cause && typeof (cause as { retryable?: unknown }).retryable === 'boolean') throw cause
      throw providerNetworkError(cause)
    }
  }
}

function toolDefinitions(request: LLMRequestProjection): Array<{ name: string; description?: string; input_schema: JsonValue }> {
  const block = request.blocks.find((candidate) => candidate.kind === 'tools')
  const content = block?.content
  const values: JsonValue[] = Array.isArray(content) ? content : content && typeof content === 'object' && !Array.isArray(content) && Array.isArray((content as Record<string, JsonValue>).tools) ? (content as Record<string, JsonValue>).tools as JsonValue[] : []
  return values.filter((value): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.name === 'string').map((value) => ({ name: value.name as string, ...(typeof value.description === 'string' ? { description: value.description } : {}), input_schema: (value.inputSchema ?? value.parameters ?? {}) as JsonValue }))
}

function anthropicToolChoice(choice: NonNullable<ProviderPresetConfig['toolChoice']>): Record<string, string> | undefined {
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'required') return { type: 'any' }
  if (choice === 'none') return undefined
  return { type: 'tool', name: choice.function.name }
}
