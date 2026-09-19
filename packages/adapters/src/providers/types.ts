import type { LLMRequestProjection, LLMResult } from '@pulse/runtime'

export interface ProviderAdapter {
  readonly id: string
  readonly name: string
  executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; onObservation?: (chunk: string) => void }): Promise<LLMResult>
}
export interface ProviderPresetConfig { provider: string; apiKey?: string; baseURL?: string; defaultModel?: string; extraHeaders?: Record<string, string> }
