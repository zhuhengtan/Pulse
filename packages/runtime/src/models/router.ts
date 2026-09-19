import type { LLMRequestProjection, PrivacyLabel } from '../core/types.js'

export interface ModelCapabilities { toolCalling?: boolean; structuredOutput?: boolean; maxContextTokens: number; local?: boolean }
export interface ModelCandidate { id: string; providerId: string; tasks: string[]; capabilities: ModelCapabilities; priority: number }
export interface ModelRegistry { register(candidate: ModelCandidate): void; list(): ModelCandidate[] }

export class InMemoryModelRegistry implements ModelRegistry {
  private readonly candidates: ModelCandidate[] = []
  register(candidate: ModelCandidate): void { this.candidates.push(candidate) }
  list(): ModelCandidate[] { return [...this.candidates] }
}

export class ModelRouter {
  constructor(private readonly registry: ModelRegistry) {}
  route(task: string, privacy: PrivacyLabel, requirements: Partial<ModelCapabilities> = {}): ModelCandidate[] {
    return this.registry.list().filter((candidate) => candidate.tasks.includes(task) && (privacy !== 'local_only' || candidate.capabilities.local === true) && Object.entries(requirements).every(([key, value]) => candidate.capabilities[key as keyof ModelCapabilities] === value)).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }
  routeProjection(task: string, projection: LLMRequestProjection, requirements: Partial<ModelCapabilities> = {}): ModelCandidate[] { return this.route(task, projection.privacy, requirements) }
}

export interface LLMResult {
  text: string
  structured?: unknown
  toolCalls: Array<{ toolCallId: string; name: string; input: unknown }>
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
  privacy?: PrivacyLabel
  derivedFrom?: string[]
}

export function assertCloudAllowed(projection: LLMRequestProjection, candidate: ModelCandidate): void {
  if (projection.privacy === 'local_only' && candidate.capabilities.local !== true) throw new Error('PRIVACY_CLOUD_BLOCKED')
}
