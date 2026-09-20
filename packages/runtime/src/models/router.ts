import type { LLMRequestProjection, PrivacyLabel } from '../core/types.js'

export interface ModelCapabilities { toolCalling?: boolean; structuredOutput?: boolean; maxContextTokens: number; local?: boolean }
export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  uncachedInputTokens?: number
  latencyMs?: number
  cost?: { amount: number; currency: string; source: 'reported' | 'estimated'; pricingVersion?: string }
}
export interface ModelCandidate { id: string; providerId: string; tasks: string[]; capabilities: ModelCapabilities; priority: number }
export interface ModelRouteDiagnostic { id: string; providerId: string; accepted: boolean; reasons: string[] }
export interface ModelRegistry { register(candidate: ModelCandidate): void; list(): ModelCandidate[] }

export class InMemoryModelRegistry implements ModelRegistry {
  private readonly candidates: ModelCandidate[] = []
  register(candidate: ModelCandidate): void { this.candidates.push(candidate) }
  list(): ModelCandidate[] { return [...this.candidates] }
}

/** Conservative admission estimate used before a provider attempt is started. */
export function estimateProjectionTokens(projection: LLMRequestProjection): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(projection.blocks), 'utf8') / 4)
}

export class ModelRouter {
  constructor(private readonly registry: ModelRegistry) {}
  route(task: string, privacy: PrivacyLabel, requirements: Partial<ModelCapabilities> = {}): ModelCandidate[] { return this.diagnostics(task, privacy, requirements).filter((item) => item.accepted).map((item) => this.registry.list().find((candidate) => candidate.id === item.id)!).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)) }
  routeProjection(task: string, projection: LLMRequestProjection, requirements: Partial<ModelCapabilities> = {}): ModelCandidate[] {
    const estimatedTokens = estimateProjectionTokens(projection)
    return this.diagnostics(task, projection.privacy, requirements, estimatedTokens).filter((item) => item.accepted).map((item) => this.registry.list().find((candidate) => candidate.id === item.id)!).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }
  diagnostics(task: string, privacy: PrivacyLabel, requirements: Partial<ModelCapabilities> = {}, estimatedTokens?: number): ModelRouteDiagnostic[] {
    return this.registry.list().map((candidate) => {
      const reasons: string[] = []
      if (!candidate.tasks.includes(task)) reasons.push('TASK_NOT_SUPPORTED')
      if (privacy === 'local_only' && candidate.capabilities.local !== true) reasons.push('PRIVACY_CLOUD_BLOCKED')
      for (const [key, value] of Object.entries(requirements)) if (candidate.capabilities[key as keyof ModelCapabilities] !== value) reasons.push(`CAPABILITY_MISSING:${key}`)
      if (estimatedTokens !== undefined && candidate.capabilities.maxContextTokens < estimatedTokens) reasons.push('CONTEXT_WINDOW_TOO_SMALL')
      return { id: candidate.id, providerId: candidate.providerId, accepted: reasons.length === 0, reasons }
    })
  }
}

export interface LLMResult {
  text: string
  structured?: unknown
  toolCalls: Array<{ toolCallId: string; name: string; input: unknown }>
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  usage?: ModelUsage
  privacy?: PrivacyLabel
  derivedFrom?: string[]
}

export function validateJsonSchema(value: unknown, schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false
  const document = schema as Record<string, unknown>
  if (Array.isArray(document.anyOf)) return document.anyOf.some((candidate) => validateJsonSchema(value, candidate))
  if (Array.isArray(document.oneOf)) return document.oneOf.filter((candidate) => validateJsonSchema(value, candidate)).length === 1
  if (Array.isArray(document.allOf) && document.allOf.some((candidate) => !validateJsonSchema(value, candidate))) return false
  if (document.not !== undefined && validateJsonSchema(value, document.not)) return false
  if (document.const !== undefined && JSON.stringify(value) !== JSON.stringify(document.const)) return false
  if (Array.isArray(document.enum) && !document.enum.some((candidate) => JSON.stringify(value) === JSON.stringify(candidate))) return false
  if (typeof document.type === 'string') {
    const matches = document.type === 'null' ? value === null : document.type === 'boolean' ? typeof value === 'boolean' : document.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : document.type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : document.type === 'string' ? typeof value === 'string' : document.type === 'array' ? Array.isArray(value) : document.type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value) : true
    if (!matches) return false
  }
  if (typeof value === 'string') {
    if (typeof document.minLength === 'number' && value.length < document.minLength) return false
    if (typeof document.maxLength === 'number' && value.length > document.maxLength) return false
    if (typeof document.pattern === 'string') {
      try { if (!new RegExp(document.pattern).test(value)) return false } catch { return false }
    }
  }
  if (Array.isArray(value)) {
    if (typeof document.minItems === 'number' && value.length < document.minItems) return false
    if (typeof document.maxItems === 'number' && value.length > document.maxItems) return false
    if (document.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false
    if (document.items !== undefined && value.some((item) => !validateJsonSchema(item, document.items))) return false
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof document.minimum === 'number' && value < document.minimum) return false
    if (typeof document.maximum === 'number' && value > document.maximum) return false
    if (typeof document.exclusiveMinimum === 'number' && value <= document.exclusiveMinimum) return false
    if (typeof document.exclusiveMaximum === 'number' && value >= document.exclusiveMaximum) return false
    if (typeof document.multipleOf === 'number' && document.multipleOf > 0 && Math.abs(value / document.multipleOf - Math.round(value / document.multipleOf)) > Number.EPSILON) return false
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (Array.isArray(document.required) && document.required.some((key) => typeof key !== 'string' || !(key in object))) return false
    if (document.properties && typeof document.properties === 'object' && !Array.isArray(document.properties)) {
      for (const [key, childSchema] of Object.entries(document.properties as Record<string, unknown>)) if (key in object && !validateJsonSchema(object[key], childSchema)) return false
      if (document.additionalProperties === false && Object.keys(object).some((key) => !(key in (document.properties as Record<string, unknown>)))) return false
      if (document.additionalProperties && typeof document.additionalProperties === 'object' && Object.keys(object).some((key) => !(key in (document.properties as Record<string, unknown>)) && !validateJsonSchema(object[key], document.additionalProperties))) return false
    }
  }
  return true
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
  constructor(readonly layer: OutputValidationLayer, readonly code: string, message: string) { super(`${code}: ${message}`) }
}

export function validateAdapterResult(result: LLMResult): LLMResult {
  if (typeof result.text !== 'string' || !Array.isArray(result.toolCalls) || !['stop', 'tool_calls', 'length', 'error'].includes(result.finishReason)) throw new OutputValidationError('adapter', 'INVALID_PROVIDER_RESPONSE', 'Provider response is not a normalized LLMResult')
  if (result.toolCalls.some((call) => typeof call.toolCallId !== 'string' || typeof call.name !== 'string' || call.name.length === 0)) throw new OutputValidationError('adapter', 'INVALID_TOOL_CALL', 'Normalized tool call is missing a stable id or name')
  if (result.finishReason === 'tool_calls' && result.toolCalls.length === 0) throw new OutputValidationError('adapter', 'INVALID_TOOL_CALL_FINISH_REASON', 'tool_calls finish reason requires at least one tool call')
  if (result.finishReason !== 'tool_calls' && result.toolCalls.length > 0) throw new OutputValidationError('adapter', 'UNEXPECTED_TOOL_CALL', 'A non-tool finish reason cannot contain tool calls')
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
