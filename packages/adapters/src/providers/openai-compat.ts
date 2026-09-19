import type { LLMRequestProjection } from '@pulse/runtime'
import { normalizeOpenAIResponse } from './normalize.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name = 'OpenAI Compatible'
  private readonly baseURL: string
  constructor(readonly id: string, private readonly config: ProviderPresetConfig) { this.baseURL = config.baseURL ?? 'https://api.openai.com/v1' }
  async executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; onObservation?: (chunk: string) => void }) {
    const response = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: params.signal, headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...(this.config.extraHeaders ?? {}) }, body: JSON.stringify({ model: this.config.defaultModel, messages: params.request.blocks.map((block) => ({ role: block.kind === 'system' ? 'system' : 'user', content: block.content })) }) })
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`)
    return normalizeOpenAIResponse(await response.json())
  }
}
