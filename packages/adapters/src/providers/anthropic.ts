import type { LLMRequestProjection } from '@pulse/runtime'
import { normalizeAnthropicResponse } from './normalize.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'
export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'Anthropic Messages'
  constructor(readonly id: string, private readonly config: ProviderPresetConfig) {}
  async executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal }) {
    const response = await fetch(`${(this.config.baseURL ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}), 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: this.config.defaultModel, max_tokens: 4096, messages: [{ role: 'user', content: params.request.blocks.map((block) => ({ type: 'text', text: JSON.stringify(block.content) })) }] }) })
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`)
    return normalizeAnthropicResponse(await response.json())
  }
}
