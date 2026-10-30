import { AnthropicAdapter } from './anthropic.js'
import { OpenAICompatibleAdapter } from './openai-compat.js'
import { MockAdapter } from './mock.js'
import { ResponsesAdapter } from './responses.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'
export function createProviderAdapter(config: ProviderPresetConfig): ProviderAdapter {
  if (config.apiMode !== undefined && !['chat-completions', 'responses'].includes(config.apiMode)) throw new Error('PROVIDER_API_MODE_INVALID')
  if (config.apiMode === 'responses') return new ResponsesAdapter(config.provider, config)
  if (config.provider === 'anthropic') return new AnthropicAdapter(config.provider, config)
  if (config.provider === 'mock') return new MockAdapter()
  return new OpenAICompatibleAdapter(config.provider, config)
}
