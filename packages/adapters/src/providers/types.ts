import type { ReasoningEffort } from '@hunterzhu/pulse-runtime'
import type { JsonValue, LLMRequestProjection, LLMResult } from '@hunterzhu/pulse-runtime'

export type ProviderToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }

export interface ProviderAdapter {
  readonly id: string
  /** Transport family; id can be a user-defined routing/credential namespace. */
  readonly providerKind?: string
  readonly name: string
  releaseConnectionScope?(scope: string): void
  dispose?(): void
  executeAttempt(params: { request: LLMRequestProjection; connectionKey?: string; signal: AbortSignal; onObservation?: (chunk: string) => void; onReasoning?: (chunk: string) => void; onRequest?: (diagnostic: import('./request-diagnostics.js').RequestDiagnostic) => void; model?: string; outputSchema?: JsonValue; maxOutputTokens?: number; reasoningEffort?: ReasoningEffort; ignoreConfiguredReasoning?: boolean; strictReasoning?: boolean; supportedReasoningEfforts?: readonly ReasoningEffort[]; beforeRetryAttempt?: () => Promise<void> }): Promise<LLMResult>
}
export type ProviderApiMode = 'chat-completions' | 'responses'
export interface ProviderPresetConfig { provider: string; apiMode?: ProviderApiMode; responsesTransport?: 'http' | 'websocket'; continuationNamespace?: string; continuationConfigVersion?: string; apiKey?: string; baseURL?: string; defaultModel?: string; remote?: boolean; maxContextTokens?: number; maxOutputTokens?: number; toolChoice?: ProviderToolChoice; extraHeaders?: Record<string, string>; reasoningEffort?: ReasoningEffort | undefined; capabilityProfile?: Partial<import('./canonical/types.js').ModelCapabilityProfile> }
