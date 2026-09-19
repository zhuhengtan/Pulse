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

export interface ModelAttemptDescriptor {
  effectId: string
  attemptId: string
  attemptNo: number
  candidate: ModelCandidate
}

export interface ModelFallbackError {
  retryable: boolean
  localClosed: boolean
  sideEffectState: 'none' | 'applied' | 'known' | 'unknown'
  reconciled?: boolean
  cause: unknown
}

export interface ModelFallbackResult {
  result: LLMResult
  candidate: ModelCandidate
  attempts: ModelAttemptDescriptor[]
}

export class ModelFallbackController {
  async execute(
    effectId: string,
    candidates: ModelCandidate[],
    run: (attempt: ModelAttemptDescriptor) => Promise<LLMResult>,
  ): Promise<ModelFallbackResult> {
    if (candidates.length === 0) throw new Error('NO_MODEL_CANDIDATE')
    const attempts: ModelAttemptDescriptor[] = []
    let lastError: ModelFallbackError | undefined
    for (const [index, candidate] of candidates.entries()) {
      if (lastError && (!lastError.retryable || !lastError.localClosed || (lastError.sideEffectState === 'unknown' && !lastError.reconciled) || (lastError.sideEffectState === 'applied' && !lastError.reconciled))) break
      const attempt: ModelAttemptDescriptor = { effectId, attemptId: `${effectId}-attempt-${index + 1}`, attemptNo: index + 1, candidate }
      attempts.push(attempt)
      try { return { result: await run(attempt), candidate, attempts } }
      catch (cause) {
        lastError = toModelFallbackError(cause) ?? { retryable: false, localClosed: false, sideEffectState: 'none', cause }
      }
    }
    throw lastError?.cause ?? new Error('MODEL_FALLBACK_FAILED')
  }
}

export function modelFallbackError(input: Omit<ModelFallbackError, 'cause'> & { cause: unknown }): Error & { modelFallback: ModelFallbackError } {
  const error = new Error('MODEL_ATTEMPT_FAILED') as Error & { modelFallback: ModelFallbackError }
  error.modelFallback = input
  return error
}

function toModelFallbackError(cause: unknown): ModelFallbackError | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined
  const candidate = 'modelFallback' in cause ? cause.modelFallback : cause
  if (typeof candidate !== 'object' || candidate === null || !('retryable' in candidate) || !('localClosed' in candidate) || !('sideEffectState' in candidate) || !('cause' in candidate)) return undefined
  return candidate as ModelFallbackError
}

export type OutputValidationLayer = 'adapter' | 'structured' | 'action'

export class OutputValidationError extends Error {
  constructor(readonly layer: OutputValidationLayer, readonly code: string, message: string) { super(message) }
}

export function validateAdapterResult(result: LLMResult): LLMResult {
  if (typeof result.text !== 'string' || !Array.isArray(result.toolCalls) || !['stop', 'tool_calls', 'length', 'error'].includes(result.finishReason)) throw new OutputValidationError('adapter', 'INVALID_PROVIDER_RESPONSE', 'Provider response is not a normalized LLMResult')
  if (result.toolCalls.some((call) => typeof call.toolCallId !== 'string' || typeof call.name !== 'string' || call.name.length === 0)) throw new OutputValidationError('adapter', 'INVALID_TOOL_CALL', 'Normalized tool call is missing a stable id or name')
  return result
}

export function validateStructuredOutput<T>(result: LLMResult, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } }): T {
  const parsed = schema.safeParse(result.structured ?? result.text)
  if (!parsed.success) throw new OutputValidationError('structured', 'STRUCTURED_OUTPUT_REJECTED', 'Structured output did not match the declared schema')
  return parsed.data
}

export function validateActionToolCalls(result: LLMResult, allowedTools: ReadonlySet<string>): void {
  if (result.toolCalls.some((call) => !allowedTools.has(call.name))) throw new OutputValidationError('action', 'ACTION_TOOL_NOT_ALLOWED', 'Model requested a tool that is not present in the current tool set')
}
