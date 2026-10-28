export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown'
export interface DiscoveredModel {
  modelCode: string
  displayName: string
  maxContextTokens?: number
  maxOutputTokens?: number
  imageInput: CapabilityStatus
  tools: CapabilityStatus
  structuredOutput: CapabilityStatus
  remote?: boolean
}
export interface ProviderVariant {
  id: string
  name: string
  provider: string
  baseURL: string
  discovery: 'openai' | 'anthropic' | 'catalog' | 'ollama'
  auth?: 'required' | 'optional' | 'none'
  editableBaseURL?: boolean
  loopbackOnly?: boolean
  catalog?: DiscoveredModel[]
  available?: boolean
  unavailableReason?: string
}
export interface ProviderPreset {
  id: string
  name: string
  category: 'official' | 'aggregator' | 'custom'
  keyURL: string
  docsURL: string
  catalogVersion: string
  variants: ProviderVariant[]
}
export interface ProviderDiscovery {
  models: DiscoveredModel[]
  source: 'remote' | 'catalog'
  sourceURL: string
  catalogVersion: string
  authenticated: boolean
}
export interface ProviderConnectionInput {
  remote?: boolean
  structuredOutput?: CapabilityStatus
  presetId: string
  connectionVariant: string
  providerId?: string
  name?: string
  apiKey?: string
  baseURL?: string
  modelCode?: string
}
export interface ProbeCheck { status: 'passed' | 'failed' | 'unsupported' | 'skipped'; code?: string }
export interface ProviderProbe {
  modelCode: string
  chat: ProbeCheck
  tools: ProbeCheck
  structuredOutput: ProbeCheck
}
