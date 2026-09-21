import type { JsonValue, LLMRequestProjection, PrivacyLabel, ProvenanceRef } from '../core/types.js'

export type ReasoningLevel = 'low' | 'medium' | 'high'
export interface ModelCapabilities { toolCalling?: boolean; structuredOutput?: boolean; reasoning?: ReasoningLevel; maxContextTokens: number; maxOutputTokens?: number; local?: boolean }
export interface ModelRouteRequirements extends Partial<ModelCapabilities> { contextSize?: number }
export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  uncachedInputTokens?: number
  latencyMs?: number
  cost?: { amount: number; currency: string; source: 'reported' | 'estimated'; pricingVersion?: string }
}
export interface ModelAdapter {
  executeAttempt(params: { request: LLMRequestProjection; signal: AbortSignal; onObservation?: (chunk: string) => void; model?: string; outputSchema?: JsonValue; maxOutputTokens?: number }): Promise<LLMResult>
}
export interface ModelCandidate { id: string; providerId: string; tasks: string[]; capabilities: ModelCapabilities; priority: number; adapter?: ModelAdapter }
export interface ModelRouteDiagnostic { id: string; providerId: string; accepted: boolean; reasons: string[] }
export interface ModelRegistry { register(candidate: ModelCandidate): void; list(): ModelCandidate[] }
export interface ModelRoute { task: string; candidates: string[] }
export interface ModelHostPolicy { allowCloud?: boolean }
export interface ModelRouteFeedback {
  modelId: string
  providerId?: string
  outcome: 'succeeded' | 'failed' | 'refused' | 'schema_rejected'
  quality?: number
  usage?: ModelUsage
}
export interface AdaptiveRoutePolicy {
  priorityWeight?: number
  qualityWeight?: number
  latencyWeight?: number
  costWeight?: number
  cacheWeight?: number
  explorationWeight?: number
  targetLatencyMs?: number
  targetCost?: number
}
export interface ModelRouteMetrics {
  attempts: number
  successes: number
  failures: number
  qualityTotal: number
  latencyTotalMs: number
  latencySamples: number
  costTotal: number
  costSamples: number
  cachedInputTokens: number
  inputTokens: number
}
export interface AdaptiveRouteSnapshot { schemaVersion: 1; metrics: Array<[string, ModelRouteMetrics]> }

function isModelCandidate(value: unknown): value is ModelCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const capabilities = candidate.capabilities
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false
  const modelCapabilities = capabilities as Record<string, unknown>
  return typeof candidate.id === 'string' && candidate.id.length > 0 && typeof candidate.providerId === 'string' && candidate.providerId.length > 0 && Array.isArray(candidate.tasks) && candidate.tasks.length > 0 && candidate.tasks.every((task) => typeof task === 'string' && task.length > 0) && typeof candidate.priority === 'number' && Number.isFinite(candidate.priority) && Number.isInteger(modelCapabilities.maxContextTokens) && (modelCapabilities.maxContextTokens as number) > 0 && (modelCapabilities.maxOutputTokens === undefined || (Number.isInteger(modelCapabilities.maxOutputTokens) && (modelCapabilities.maxOutputTokens as number) > 0)) && (modelCapabilities.local === undefined || typeof modelCapabilities.local === 'boolean') && (modelCapabilities.toolCalling === undefined || typeof modelCapabilities.toolCalling === 'boolean') && (modelCapabilities.structuredOutput === undefined || typeof modelCapabilities.structuredOutput === 'boolean') && (modelCapabilities.reasoning === undefined || ['low', 'medium', 'high'].includes(String(modelCapabilities.reasoning))) && (candidate.adapter === undefined || (typeof candidate.adapter === 'object' && candidate.adapter !== null && typeof (candidate.adapter as { executeAttempt?: unknown }).executeAttempt === 'function'))
}

export class InMemoryModelRegistry implements ModelRegistry {
  private readonly candidates: ModelCandidate[] = []
  register(candidate: ModelCandidate): void {
    if (!isModelCandidate(candidate)) throw new Error(`INVALID_MODEL_CANDIDATE:${typeof candidate === 'object' && candidate !== null && 'id' in candidate ? String((candidate as { id?: unknown }).id) : ''}`)
    if (this.candidates.some((existing) => existing.id === candidate.id)) throw new Error(`DUPLICATE_MODEL_CANDIDATE:${candidate.id}`)
    this.candidates.push(candidate)
  }
  list(): ModelCandidate[] { return [...this.candidates] }
}

/** Conservative admission estimate used before a provider attempt is started. */
export function estimateProjectionTokens(projection: LLMRequestProjection): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(projection.blocks), 'utf8') / 4)
}

export class ModelRouter {
  private readonly routes = new Map<string, string[]>()
  readonly hostPolicy: Required<ModelHostPolicy>

  constructor(public readonly registry: ModelRegistry, hostPolicy: ModelHostPolicy = {}) {
    this.hostPolicy = { allowCloud: hostPolicy.allowCloud ?? true }
  }

  register(route: ModelRoute): void {
    if (!route || typeof route.task !== 'string' || !route.task || !Array.isArray(route.candidates) || route.candidates.length === 0 || route.candidates.some((candidate) => typeof candidate !== 'string' || !candidate) || new Set(route.candidates).size !== route.candidates.length) throw new Error('INVALID_MODEL_ROUTE')
    this.routes.set(route.task, [...new Set(route.candidates)])
  }

  route(task: string, privacy: PrivacyLabel, requirements: ModelRouteRequirements = {}): ModelCandidate[] { return this.rankCandidates(this.candidates(task, privacy, requirements), this.routes.get(task)) }
  routeProjection(task: string, projection: LLMRequestProjection, requirements: ModelRouteRequirements = {}): ModelCandidate[] {
    const estimatedTokens = Math.max(estimateProjectionTokens(projection) + (typeof requirements.maxOutputTokens === 'number' ? requirements.maxOutputTokens : 0), typeof requirements.contextSize === 'number' ? requirements.contextSize : 0)
    return this.rankCandidates(this.candidates(task, projection.privacy, requirements, estimatedTokens), this.routes.get(task))
  }
  recordFeedback(_feedback: ModelRouteFeedback): void {}
  protected rankCandidates(candidates: ModelCandidate[], preferredOrder?: string[]): ModelCandidate[] {
    if (preferredOrder !== undefined) {
      const order = new Map(preferredOrder.map((id, index) => [id, index]))
      return candidates.sort((a, b) => (order.get(a.id) ?? Number.POSITIVE_INFINITY) - (order.get(b.id) ?? Number.POSITIVE_INFINITY) || b.priority - a.priority || a.id.localeCompare(b.id))
    }
    return candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }
  private candidates(task: string, privacy: PrivacyLabel, requirements: ModelRouteRequirements, estimatedTokens?: number): ModelCandidate[] {
    const candidates = this.registry.list()
    const allowed = this.routes.get(task)
    const diagnostics = this.diagnostics(task, privacy, requirements, estimatedTokens)
    return diagnostics.filter((item) => item.accepted && (allowed === undefined || allowed.includes(item.id))).map((item) => candidates.find((candidate) => candidate.id === item.id)!).filter(Boolean)
  }
  diagnostics(task: string, privacy: PrivacyLabel, requirements: ModelRouteRequirements = {}, estimatedTokens?: number): ModelRouteDiagnostic[] {
    const preferred = this.routes.get(task)
    return this.registry.list().map((candidate) => {
      const reasons: string[] = []
      if (preferred !== undefined && !preferred.includes(candidate.id)) reasons.push('TASK_ROUTE_EXCLUDED')
      if (!candidate.tasks.includes(task)) reasons.push('TASK_NOT_SUPPORTED')
      if (privacy === 'local_only' && candidate.capabilities.local !== true) reasons.push('PRIVACY_CLOUD_BLOCKED')
      else if (!this.hostPolicy.allowCloud && candidate.capabilities.local !== true) reasons.push('HOST_CLOUD_BLOCKED')
      for (const [key, value] of Object.entries(requirements)) {
        if (key === 'maxOutputTokens' || key === 'contextSize') continue
        if (key === 'reasoning') {
          const levels: Record<ReasoningLevel, number> = { low: 1, medium: 2, high: 3 }
          const required = value as ReasoningLevel
          if (candidate.capabilities.reasoning === undefined || levels[candidate.capabilities.reasoning] < levels[required]) reasons.push('CAPABILITY_MISSING:reasoning')
          continue
        }
        if (candidate.capabilities[key as keyof ModelCapabilities] !== value) reasons.push(`CAPABILITY_MISSING:${key}`)
      }
      if (typeof requirements.maxOutputTokens === 'number' && (candidate.capabilities.maxOutputTokens === undefined || candidate.capabilities.maxOutputTokens < requirements.maxOutputTokens)) reasons.push('OUTPUT_BUDGET_TOO_SMALL')
      if (typeof requirements.contextSize === 'number' && candidate.capabilities.maxContextTokens < requirements.contextSize) reasons.push('CONTEXT_WINDOW_TOO_SMALL')
      if (estimatedTokens !== undefined && candidate.capabilities.maxContextTokens < estimatedTokens) reasons.push('CONTEXT_WINDOW_TOO_SMALL')
      return { id: candidate.id, providerId: candidate.providerId, accepted: reasons.length === 0, reasons }
    })
  }
}

/** Deterministic feedback-driven routing. It only affects future candidate ordering. */
export class AdaptiveModelRouter extends ModelRouter {
  private readonly feedback = new Map<string, ModelRouteMetrics>()
  private readonly policy: Required<AdaptiveRoutePolicy>

  constructor(registry: ModelRegistry, policy: AdaptiveRoutePolicy = {}, hostPolicy: ModelHostPolicy = {}) {
    super(registry, hostPolicy)
    this.policy = {
      priorityWeight: policy.priorityWeight ?? 1,
      qualityWeight: policy.qualityWeight ?? 4,
      latencyWeight: policy.latencyWeight ?? 1,
      costWeight: policy.costWeight ?? 1,
      cacheWeight: policy.cacheWeight ?? 0.5,
      explorationWeight: policy.explorationWeight ?? 0.25,
      targetLatencyMs: policy.targetLatencyMs ?? 1_000,
      targetCost: policy.targetCost ?? 1,
    }
  }

  static fromSnapshot(registry: ModelRegistry, snapshot: AdaptiveRouteSnapshot, policy: AdaptiveRoutePolicy = {}): AdaptiveModelRouter {
    const router = new AdaptiveModelRouter(registry, policy)
    router.restore(snapshot)
    return router
  }

  snapshot(): AdaptiveRouteSnapshot { return { schemaVersion: 1, metrics: [...this.feedback.entries()].map(([id, metrics]) => [id, { ...metrics }]) } }

  restore(snapshot: AdaptiveRouteSnapshot): void {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.metrics)) throw new Error('INVALID_ADAPTIVE_ROUTE_SNAPSHOT')
    const known = new Set(this.registry.list().map((candidate) => candidate.id))
    this.feedback.clear()
    for (const entry of snapshot.metrics) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !known.has(entry[0])) throw new Error('INVALID_ADAPTIVE_ROUTE_SNAPSHOT')
      const metrics = entry[1]
      if (!metrics || !Number.isInteger(metrics.attempts) || metrics.attempts < 0 || !Number.isInteger(metrics.successes) || metrics.successes < 0 || !Number.isInteger(metrics.failures) || metrics.failures < 0 || metrics.successes + metrics.failures > metrics.attempts || !Object.values(metrics).every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new Error('INVALID_ADAPTIVE_ROUTE_SNAPSHOT')
      this.feedback.set(entry[0], { ...metrics })
    }
  }

  recordFeedback(feedback: ModelRouteFeedback): void {
    if (!this.registry.list().some((candidate) => candidate.id === feedback.modelId)) return
    const metrics = this.feedback.get(feedback.modelId) ?? { attempts: 0, successes: 0, failures: 0, qualityTotal: 0, latencyTotalMs: 0, latencySamples: 0, costTotal: 0, costSamples: 0, cachedInputTokens: 0, inputTokens: 0 }
    metrics.attempts++
    if (feedback.outcome === 'succeeded') metrics.successes++
    else metrics.failures++
    const quality = feedback.quality ?? (feedback.outcome === 'succeeded' ? 1 : 0)
    if (Number.isFinite(quality)) metrics.qualityTotal += Math.max(0, Math.min(1, quality))
    const latency = feedback.usage?.latencyMs
    if (latency !== undefined && Number.isFinite(latency) && latency >= 0) { metrics.latencyTotalMs += latency; metrics.latencySamples++ }
    const cost = feedback.usage?.cost?.amount
    if (cost !== undefined && Number.isFinite(cost) && cost >= 0) { metrics.costTotal += cost; metrics.costSamples++ }
    const inputTokens = feedback.usage?.inputTokens
    const cachedInputTokens = feedback.usage?.cachedInputTokens
    if (inputTokens !== undefined && cachedInputTokens !== undefined && Number.isFinite(inputTokens) && Number.isFinite(cachedInputTokens) && inputTokens > 0 && cachedInputTokens >= 0) {
      metrics.inputTokens += inputTokens
      metrics.cachedInputTokens += Math.min(inputTokens, cachedInputTokens)
    }
    this.feedback.set(feedback.modelId, metrics)
  }

  metrics(): ReadonlyMap<string, ModelRouteMetrics> { return new Map([...this.feedback.entries()].map(([id, metrics]) => [id, { ...metrics }])) }

  protected rankCandidates(candidates: ModelCandidate[], preferredOrder?: string[]): ModelCandidate[] {
    const score = (candidate: ModelCandidate): number => {
      const metrics = this.feedback.get(candidate.id)
      const attempts = metrics?.attempts ?? 0
      const quality = attempts ? (metrics?.qualityTotal ?? 0) / attempts : 0.5
      const latency = metrics?.latencySamples ? 1 / (1 + (metrics.latencyTotalMs / metrics.latencySamples) / Math.max(1, this.policy.targetLatencyMs)) : 0.5
      const cost = metrics?.costSamples ? 1 / (1 + (metrics.costTotal / metrics.costSamples) / Math.max(Number.MIN_VALUE, this.policy.targetCost)) : 0.5
      const cache = metrics?.inputTokens ? Math.max(0, Math.min(1, (metrics.cachedInputTokens / metrics.inputTokens))) : 0
      const exploration = 1 / Math.sqrt(attempts + 1)
      return this.policy.priorityWeight * candidate.priority + this.policy.qualityWeight * quality + this.policy.latencyWeight * latency + this.policy.costWeight * cost + this.policy.cacheWeight * cache + this.policy.explorationWeight * exploration
    }
    if (preferredOrder !== undefined) {
      const order = new Map(preferredOrder.map((id, index) => [id, index]))
      return candidates.sort((a, b) => score(b) - score(a) || (order.get(a.id) ?? Number.POSITIVE_INFINITY) - (order.get(b.id) ?? Number.POSITIVE_INFINITY) || b.priority - a.priority || a.id.localeCompare(b.id))
    }
    return candidates.sort((a, b) => score(b) - score(a) || b.priority - a.priority || a.id.localeCompare(b.id))
  }
}

export interface LLMResult {
  text: string
  structured?: unknown
  refusal?: string
  toolCalls: Array<{ toolCallId: string; name: string; input: unknown }>
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error' | 'refusal'
  usage?: ModelUsage
  privacy?: PrivacyLabel
  derivedFrom?: ProvenanceRef[]
}

/** Provider call ids are adapter-local; Runtime owns the stable ToolCall id. */
export function assignRuntimeToolCallIds(result: LLMResult, effectId: string): LLMResult {
  return { ...result, toolCalls: result.toolCalls.map((call, index) => ({ ...call, toolCallId: `${effectId}:tool:${index + 1}` })) }
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
    const matches = document.type === 'null' ? value === null : document.type === 'boolean' ? typeof value === 'boolean' : document.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : document.type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : document.type === 'string' ? typeof value === 'string' : document.type === 'array' ? Array.isArray(value) : document.type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value) : false
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
    maxAttempts = candidates.length,
  ): Promise<ModelFallbackResult> {
    if (candidates.length === 0) throw new Error('NO_MODEL_CANDIDATE')
    const attempts: ModelAttemptDescriptor[] = []
    let lastError: ModelFallbackError | undefined
    for (const [index, candidate] of candidates.slice(0, Math.max(0, maxAttempts)).entries()) {
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

function validNonNegativeMetric(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function validateUsage(usage: unknown): void {
  if (usage === undefined) return
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new OutputValidationError('adapter', 'INVALID_USAGE', 'Provider usage must be an object')
  const value = usage as Record<string, unknown>
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'uncachedInputTokens']) if (value[key] !== undefined && (!Number.isInteger(value[key]) || !validNonNegativeMetric(value[key]))) throw new OutputValidationError('adapter', 'INVALID_USAGE', `Provider usage ${key} must be a non-negative integer`)
  if (value.latencyMs !== undefined && !validNonNegativeMetric(value.latencyMs)) throw new OutputValidationError('adapter', 'INVALID_USAGE', 'Provider usage latencyMs must be non-negative')
  if (value.inputTokens !== undefined && value.cachedInputTokens !== undefined && (value.cachedInputTokens as number) > (value.inputTokens as number)) throw new OutputValidationError('adapter', 'INVALID_USAGE', 'Cached input tokens cannot exceed input tokens')
  if (value.inputTokens !== undefined && value.uncachedInputTokens !== undefined && (value.uncachedInputTokens as number) > (value.inputTokens as number)) throw new OutputValidationError('adapter', 'INVALID_USAGE', 'Uncached input tokens cannot exceed input tokens')
  if (value.cost !== undefined) {
    if (!value.cost || typeof value.cost !== 'object' || Array.isArray(value.cost)) throw new OutputValidationError('adapter', 'INVALID_USAGE', 'Provider usage cost must be an object')
    const cost = value.cost as Record<string, unknown>
    if (!validNonNegativeMetric(cost.amount) || typeof cost.currency !== 'string' || cost.currency.length === 0 || !['reported', 'estimated'].includes(String(cost.source)) || (cost.pricingVersion !== undefined && typeof cost.pricingVersion !== 'string')) throw new OutputValidationError('adapter', 'INVALID_USAGE', 'Provider usage cost is malformed')
  }
}

export function validateAdapterResult(result: LLMResult): LLMResult {
  if (typeof result.text !== 'string' || !Array.isArray(result.toolCalls) || !['stop', 'tool_calls', 'length', 'error', 'refusal'].includes(result.finishReason)) throw new OutputValidationError('adapter', 'PROVIDER_RESPONSE_INVALID', 'Provider response is not a normalized LLMResult')
  validateUsage(result.usage)
  if (result.toolCalls.some((call) => typeof call.toolCallId !== 'string' || typeof call.name !== 'string' || call.name.length === 0)) throw new OutputValidationError('adapter', 'INVALID_TOOL_CALL', 'Normalized tool call is missing a stable id or name')
  if (result.finishReason === 'tool_calls' && result.toolCalls.length === 0) throw new OutputValidationError('adapter', 'INVALID_TOOL_CALL_FINISH_REASON', 'tool_calls finish reason requires at least one tool call')
  if (result.finishReason !== 'tool_calls' && result.toolCalls.length > 0) throw new OutputValidationError('adapter', 'UNEXPECTED_TOOL_CALL', 'A non-tool finish reason cannot contain tool calls')
  if (result.finishReason === 'refusal' && (!result.refusal || result.refusal.length === 0)) throw new OutputValidationError('adapter', 'INVALID_REFUSAL', 'A refusal finish reason requires a refusal message')
  if (result.finishReason !== 'refusal' && result.refusal !== undefined) throw new OutputValidationError('adapter', 'UNEXPECTED_REFUSAL', 'A non-refusal result cannot contain a refusal message')
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
