import type { JsonValue, LLMRequestProjection, LLMResult } from '@hunterzhu/pulse-runtime'

export type ProviderToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }

export interface ProviderAdapter {
  readonly id: string
  readonly name: string
  executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; onObservation?: (chunk: string) => void; model?: string; outputSchema?: JsonValue; maxOutputTokens?: number }): Promise<LLMResult>
}
export interface ProviderPresetConfig { provider: string; apiKey?: string; baseURL?: string; defaultModel?: string; maxOutputTokens?: number; toolChoice?: ProviderToolChoice; extraHeaders?: Record<string, string>; reasoningEffort?: 'low' | 'medium' | 'high' | undefined }
