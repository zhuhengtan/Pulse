import { AnthropicAdapter } from './anthropic.js'
import { OpenAICompatibleAdapter } from './openai-compat.js'
import { MockAdapter } from './mock.js'
import type { ProviderAdapter, ProviderPresetConfig } from './types.js'
export function createProviderAdapter(config: ProviderPresetConfig): ProviderAdapter { if (config.provider === 'anthropic') return new AnthropicAdapter(config.provider, config); if (config.provider === 'mock') return new MockAdapter(); return new OpenAICompatibleAdapter(config.provider, config) }
