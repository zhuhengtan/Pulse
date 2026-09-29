import type { JsonValue } from '@hunterzhu/pulse-runtime'
import type { ProviderToolChoice } from '../types.js'

export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool'

export interface CanonicalTextContent {
  type: 'text'
  text: string
}

export interface CanonicalImageContent {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    mediaType: string
    data: string
  }
}

export type CanonicalContentPart = CanonicalTextContent | CanonicalImageContent

export interface CanonicalToolCall {
  id: string
  name: string
  arguments: string
}

export interface CanonicalMessage {
  role: CanonicalRole
  content: string | null | CanonicalContentPart[]
  name?: string
  toolCallId?: string
  toolCalls?: CanonicalToolCall[]
  reasoningContent?: string
}

export interface CanonicalToolDefinition {
  name: string
  description?: string
  parameters: JsonValue
}

export type CanonicalToolChoice = ProviderToolChoice

export interface CanonicalStructuredOutput {
  name?: string
  schema: JsonValue
  strict?: boolean
  description?: string
  mode?: 'json_schema' | 'json_object'
}

export interface CanonicalReasoningConfig {
  effort?: 'low' | 'medium' | 'high'
  budgetTokens?: number
  enabled?: boolean
}

export interface CanonicalLLMRequest {
  model?: string
  messages: CanonicalMessage[]
  tools?: CanonicalToolDefinition[]
  toolChoice?: CanonicalToolChoice
  temperature?: number
  topP?: number
  maxTokens?: number
  stop?: string[]
  reasoning?: CanonicalReasoningConfig
  structuredOutput?: CanonicalStructuredOutput
  stream?: boolean
}

export type CanonicalStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'refusal_delta'; refusal: string }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedInputTokens?: number } }
  | { type: 'finish'; reason: string }

export type StructuredOutputCapability = 'native_strict' | 'native_loose' | 'json_object_only' | 'unsupported'
export type ReasoningCapability = 'effort_param' | 'budget_tokens' | 'prompt_mode' | 'unsupported'

export interface ModelCapabilityConstraints {
  disallowTemperatureWithReasoning?: boolean
  defaultTemperatureWithReasoning?: number
  maxTokensParamName?: 'max_tokens' | 'max_completion_tokens'
  supportsSystemMessage?: boolean
  supportsParallelTools?: boolean
}

export interface ModelCapabilityProfile {
  id: string
  provider: string
  structuredOutput: StructuredOutputCapability
  reasoning: ReasoningCapability
  constraints: ModelCapabilityConstraints
}

export interface AdaptedCanonicalRequest {
  request: CanonicalLLMRequest
  capability: ModelCapabilityProfile
  clientSchemaValidationRequired: boolean
  toolNameAliases: ReadonlyMap<string, string>
}
