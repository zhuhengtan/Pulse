import type { EffectExecutor, EffectExecution, JsonValue, LLMRequestProjection, LLMResult, ModelCandidate, ModelRouteRequirements, ModelRouter } from '@hunterzhu/pulse-runtime'
import { assignRuntimeToolCallIds, ModelFallbackController, OutputValidationError, estimateProjectionTokens, stableSerialize, validateAdapterResult, validateJsonSchema, modelFallbackError, runtimeErrorFromCause } from '@hunterzhu/pulse-runtime'
import type { ProviderAdapter } from './types.js'

class AsyncSlot {
  private active = 0
  private readonly pending: Array<{ signal: AbortSignal | undefined; resolve: (release: () => void) => void; reject: (error: unknown) => void }> = []
  constructor(private readonly limit: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.limit === Number.POSITIVE_INFINITY || this.active < this.limit) { this.active++; return () => this.release() }
    if (signal?.aborted) throw new Error('EFFECT_CANCELLED')
    return new Promise<() => void>((resolve, reject) => {
      const request = { signal, resolve, reject }
      const onAbort = (): void => { const index = this.pending.indexOf(request); if (index >= 0) this.pending.splice(index, 1); reject(new Error('EFFECT_CANCELLED')) }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.pending.push(request)
    })
  }
  private release(): void {
    const next = this.pending.shift()
    if (!next) { this.active = Math.max(0, this.active - 1); return }
    if (next.signal?.aborted) { next.reject(new Error('EFFECT_CANCELLED')); this.release(); return }
    next.resolve(() => this.release())
  }
}

class SlotPool {
  private readonly slots = new Map<string, AsyncSlot>()
  constructor(private readonly limits: Readonly<Record<string, number>> = {}) {}
  get(key: string): AsyncSlot { let slot = this.slots.get(key); if (!slot) { slot = new AsyncSlot(this.limits[key] ?? Number.POSITIVE_INFINITY); this.slots.set(key, slot) }; return slot }
}

function toJson(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('LLM_OUTPUT_NOT_SERIALIZABLE'); return value }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('LLM_OUTPUT_NOT_SERIALIZABLE')
    seen.add(value)
    try { return value.map((item) => toJson(item, seen)) } finally { seen.delete(value) }
  }
  if (typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Date || Object.getPrototypeOf(value) !== Object.prototype || seen.has(value)) throw new Error('LLM_OUTPUT_NOT_SERIALIZABLE')
    seen.add(value)
    try { return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJson(item, seen)])) } finally { seen.delete(value) }
  }
  throw new Error('LLM_OUTPUT_NOT_SERIALIZABLE')
}

function candidateMetadata(candidate: ModelCandidate, attempts: Array<{ effectId: string; attemptId: string; attemptNo: number; candidate: ModelCandidate }>, usage: ReadonlyMap<string, NonNullable<LLMResult['usage']>>, slotWaitMs: ReadonlyMap<string, number>, routes: JsonValue): JsonValue {
  return { selected: { id: candidate.id, providerId: candidate.providerId }, routes, attempts: attempts.map((attempt) => {
    const recorded = usage.get(attempt.attemptId)
    const usageJson = recorded === undefined ? undefined : { ...(recorded.inputTokens === undefined ? {} : { inputTokens: recorded.inputTokens }), ...(recorded.outputTokens === undefined ? {} : { outputTokens: recorded.outputTokens }), ...(recorded.cachedInputTokens === undefined ? {} : { cachedInputTokens: recorded.cachedInputTokens }), ...(recorded.uncachedInputTokens === undefined ? {} : { uncachedInputTokens: recorded.uncachedInputTokens }), ...(recorded.latencyMs === undefined ? {} : { latencyMs: recorded.latencyMs }), ...(recorded.cost === undefined ? {} : { cost: recorded.cost }) }
    const waited = slotWaitMs.get(attempt.attemptId)
    return { effectId: attempt.effectId, attemptId: attempt.attemptId, attemptNo: attempt.attemptNo, modelId: attempt.candidate.id, providerId: attempt.candidate.providerId, ...(waited === undefined ? {} : { slotWaitMs: waited }), ...(usageJson === undefined ? {} : { usage: usageJson }) }
  }) }
}

export function createModelEffectExecutor(config: { router: ModelRouter; providers: ReadonlyMap<string, ProviderAdapter>; requirements?: ModelRouteRequirements; maxConcurrentByProvider?: Readonly<Record<string, number>>; maxConcurrentByModel?: Readonly<Record<string, number>> }): EffectExecutor {
  const fallback = new ModelFallbackController()
  const providerSlots = new SlotPool(config.maxConcurrentByProvider)
  const modelSlots = new SlotPool(config.maxConcurrentByModel)
  return async (effect, signal, emitObservation): Promise<EffectExecution> => {
    if (effect.kind !== 'llm') throw new Error(`UNSUPPORTED_EFFECT_KIND:${effect.kind}`)
    const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
    const task = input.task
    const request = input.request
    if (typeof task !== 'string' || !request || typeof request !== 'object' || Array.isArray(request)) throw new Error('INVALID_LLM_EFFECT_INPUT')
    const projection = request as unknown as LLMRequestProjection
    const observations: NonNullable<EffectExecution['observations']> = []
    const usage = new Map<string, NonNullable<LLMResult['usage']>>()
    const slotWaitMs = new Map<string, number>()
    let lastSchemaViolation: JsonValue | undefined
    let failedForSchema = false
    const dynamicRequirements = input.requirements && typeof input.requirements === 'object' && !Array.isArray(input.requirements) ? input.requirements as Record<string, JsonValue> : {}
    const structuredRequirement = dynamicRequirements.structuredOutput
    const structuredSchema = structuredRequirement && typeof structuredRequirement === 'object' && !Array.isArray(structuredRequirement) ? (structuredRequirement as Record<string, JsonValue>).schema : undefined
    if (structuredSchema !== undefined && (input.outputSchema === undefined || stableSerialize(structuredSchema) !== stableSerialize(input.outputSchema))) return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: 'STRUCTURED_OUTPUT_CONTRACT_MISMATCH', message: 'requirements.structuredOutput.schema must equal outputSchema.' } }
    const routeRequirements: ModelRouteRequirements = { ...config.requirements, ...(typeof dynamicRequirements.toolCalling === 'boolean' ? { toolCalling: dynamicRequirements.toolCalling } : {}), ...(typeof dynamicRequirements.structuredOutput === 'boolean' ? { structuredOutput: dynamicRequirements.structuredOutput } : structuredSchema === undefined ? {} : { structuredOutput: true }), ...(dynamicRequirements.reasoning === 'low' || dynamicRequirements.reasoning === 'medium' || dynamicRequirements.reasoning === 'high' ? { reasoning: dynamicRequirements.reasoning } : {}), ...(typeof dynamicRequirements.maxOutputTokens === 'number' ? { maxOutputTokens: dynamicRequirements.maxOutputTokens } : {}), ...(typeof dynamicRequirements.contextSize === 'number' ? { contextSize: dynamicRequirements.contextSize } : {}) }
    const routeDiagnostics = config.router.diagnostics(task, projection.privacy, routeRequirements, estimateProjectionTokens(projection) + (typeof routeRequirements.maxOutputTokens === 'number' ? routeRequirements.maxOutputTokens : 0))
    const candidates = config.router.routeProjection(task, projection, routeRequirements)
    const attemptNo = Math.max(1, effect.attemptNo)
    const candidate = candidates[attemptNo - 1]
    const maxAttempts = effect.retryPolicy?.maxAttempts ?? candidates.length
    const canFallback = candidate !== undefined && attemptNo < Math.max(0, maxAttempts) && candidates[attemptNo] !== undefined
    if (candidate === undefined) return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: candidates.length === 0 ? 'NO_ELIGIBLE_MODEL' : 'MODEL_ATTEMPT_LIMIT_REACHED', message: candidates.length === 0 ? 'No model candidate satisfies the task, privacy, capability, and context requirements.' : 'No additional routed model candidate is available for this Effect.' }, metadata: { routes: routeDiagnostics as unknown as JsonValue, attempts: [] } }
    const result = await fallback.execute(effect.id, [candidate], async (attempt) => {
      failedForSchema = false
      const provider = config.providers.get(attempt.candidate.providerId)
      if (!provider) throw modelFallbackError({ retryable: false, localClosed: true, sideEffectState: 'none', cause: new Error(`UNKNOWN_PROVIDER:${attempt.candidate.providerId}`) })
      const slotStartedAt = Date.now()
      let providerRelease: (() => void)
      try { providerRelease = await providerSlots.get(attempt.candidate.providerId).acquire(signal) } catch (cause) {
        if (signal.aborted) throw modelFallbackError({ retryable: false, localClosed: true, sideEffectState: 'none', cause })
        throw cause
      }
      let modelRelease: (() => void) | undefined
      try { modelRelease = await modelSlots.get(attempt.candidate.id).acquire(signal) } catch (cause) { providerRelease(); if (signal.aborted) throw modelFallbackError({ retryable: false, localClosed: true, sideEffectState: 'none', cause }); throw cause }
      slotWaitMs.set(attempt.attemptId, Math.max(0, Date.now() - slotStartedAt))
      const releases = [providerRelease, modelRelease]
      let feedbackRecorded = false
      const recordFeedback = (outcome: 'succeeded' | 'failed' | 'refused' | 'schema_rejected', quality: number): void => {
        if (feedbackRecorded) return
        feedbackRecorded = true
        config.router.recordFeedback({ modelId: attempt.candidate.id, providerId: attempt.candidate.providerId, outcome, quality, ...(usage.get(attempt.attemptId) === undefined ? {} : { usage: usage.get(attempt.attemptId)! }) })
      }
      try {
        const startedAt = Date.now()
        const onObservation = (chunk: string): void => {
          const observation = { type: 'chunk' as const, data: chunk }
          if (emitObservation) emitObservation(observation)
          else observations.push(observation)
        }
        const output = assignRuntimeToolCallIds(validateAdapterResult(await provider.executeAttempt({ request: projection, signal, model: attempt.candidate.id, ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }), ...(typeof routeRequirements.maxOutputTokens === 'number' ? { maxOutputTokens: routeRequirements.maxOutputTokens } : {}), onObservation })), effect.id)
        const measuredUsage = output.usage === undefined ? { latencyMs: Math.max(0, Date.now() - startedAt) } : { ...output.usage, latencyMs: output.usage.latencyMs ?? Math.max(0, Date.now() - startedAt), ...(output.usage.uncachedInputTokens === undefined && output.usage.inputTokens !== undefined && output.usage.cachedInputTokens !== undefined ? { uncachedInputTokens: Math.max(0, output.usage.inputTokens - output.usage.cachedInputTokens) } : {}) }
        usage.set(attempt.attemptId, measuredUsage)
        if (output.finishReason === 'length' && input.outputSchema !== undefined) throw Object.assign(new OutputValidationError('adapter', 'OUTPUT_TRUNCATED', 'Model output reached its token limit; increase maxOutputTokens before retrying.'), { retryable: false })
        if (output.finishReason === 'refusal') { recordFeedback('refused', 0); throw new OutputValidationError('adapter', 'MODEL_REFUSAL', output.refusal ?? 'Provider refused the request.') }
        if (input.outputSchema !== undefined) {
          const candidateValue = output.structured ?? output.text
          if (!validateJsonSchema(candidateValue, input.outputSchema)) {
            lastSchemaViolation = toJson(candidateValue)
            failedForSchema = true
            recordFeedback('schema_rejected', 0)
            throw new OutputValidationError('structured', 'OUTPUT_SCHEMA_VIOLATION', 'Provider output did not match the declared schema')
          }
        }
        failedForSchema = false
        recordFeedback('succeeded', 1)
        return output
      } catch (cause) {
        recordFeedback('failed', 0)
        if (signal.aborted) throw modelFallbackError({ retryable: false, localClosed: true, sideEffectState: 'none', cause })
        const retryable = cause && typeof cause === 'object' && 'retryable' in cause && typeof (cause as { retryable?: unknown }).retryable === 'boolean' ? (cause as { retryable: boolean }).retryable : true
        throw modelFallbackError({ retryable, localClosed: true, sideEffectState: 'none', cause })
      } finally { for (const release of releases.reverse()) release() }
    }, 1).then((value) => {
      const providerAttempt = value.attempts.at(-1)
      const measuredUsage = providerAttempt === undefined ? undefined : usage.get(providerAttempt.attemptId)
      if (measuredUsage !== undefined) usage.set(effect.attemptId, measuredUsage)
      const waited = providerAttempt === undefined ? undefined : slotWaitMs.get(providerAttempt.attemptId)
      if (waited !== undefined) slotWaitMs.set(effect.attemptId, waited)
      return { ...value, attempts: value.attempts.map((attempt) => ({ ...attempt, effectId: effect.id })) }
    }).catch((cause) => {
      if (failedForSchema && lastSchemaViolation !== undefined) return { result: { text: '', toolCalls: [], finishReason: 'error' as const }, candidate, attempts: [{ effectId: effect.id, attemptId: effect.attemptId, attemptNo, candidate }], schemaRejected: lastSchemaViolation }
      const inner = cause && typeof cause === 'object' && 'modelFallback' in cause ? (cause as { modelFallback?: { cause?: unknown } }).modelFallback?.cause : cause
      if (inner instanceof OutputValidationError && inner.code === 'MODEL_REFUSAL') return { result: { text: '', refusal: inner.message, toolCalls: [], finishReason: 'refusal' as const }, candidate, attempts: [{ effectId: effect.id, attemptId: effect.attemptId, attemptNo, candidate }], refused: true, retryable: canFallback }
      const fallbackError = cause && typeof cause === 'object' && 'modelFallback' in cause ? (cause as { modelFallback?: { retryable?: boolean; cause?: unknown } }).modelFallback : undefined
      const error = runtimeErrorFromCause(fallbackError?.cause ?? cause, 'MODEL_EXECUTION_FAILED')
      return { result: { text: '', toolCalls: [], finishReason: 'error' as const }, candidate, attempts: [{ effectId: effect.id, attemptId: effect.attemptId, attemptNo, candidate }], failed: { ...error, ...(canFallback && fallbackError?.retryable !== false && error.retryable !== false ? { retryable: true } : {}) } }
    })
    if ('schemaRejected' in result) return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: 'OUTPUT_SCHEMA_VIOLATION', message: 'Provider output did not match the declared schema.', ...(canFallback ? { retryable: true } : {}) }, metadata: candidateMetadata(result.candidate, result.attempts, usage, slotWaitMs, routeDiagnostics as unknown as JsonValue), rejectedOutput: { value: result.schemaRejected, privacy: projection.privacy, derivedFrom: [...(effect.derivedFrom ?? [])] } }
    if ('refused' in result) return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: 'MODEL_REFUSAL', message: result.result.refusal ?? 'Provider refused the request.', ...(result.retryable ? { retryable: true } : {}) }, metadata: candidateMetadata(result.candidate, result.attempts, usage, slotWaitMs, routeDiagnostics as unknown as JsonValue) }
    if ('failed' in result) return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: result.failed, metadata: candidateMetadata(result.candidate, result.attempts, usage, slotWaitMs, routeDiagnostics as unknown as JsonValue) }
    const modelValue = input.outputSchema !== undefined || typeof input.schema === 'string' ? (result.result.structured ?? result.result.text) : result.result
    const value = toJson(modelValue)
    return { value, privacy: projection.privacy, sideEffectState: 'none', executionState: 'succeeded', metadata: candidateMetadata(result.candidate, result.attempts, usage, slotWaitMs, routeDiagnostics as unknown as JsonValue), ...(observations.length ? { observations } : {}) }
  }
}
