import type { EffectExecutor, EffectExecution, JsonValue, LLMRequestProjection, LLMResult, ModelCandidate, ModelRouter } from '@pulse/runtime'
import { ModelFallbackController, OutputValidationError, validateAdapterResult, validateJsonSchema, modelFallbackError } from '@pulse/runtime'
import type { ProviderAdapter } from './types.js'

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(toJson)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJson(item)]))
  throw new Error('LLM_OUTPUT_NOT_SERIALIZABLE')
}

function candidateMetadata(candidate: ModelCandidate, attempts: Array<{ attemptId: string; attemptNo: number; candidate: ModelCandidate }>, usage: ReadonlyMap<string, NonNullable<LLMResult['usage']>>): JsonValue {
  return { selected: { id: candidate.id, providerId: candidate.providerId }, attempts: attempts.map((attempt) => {
    const recorded = usage.get(attempt.attemptId)
    const usageJson = recorded === undefined ? undefined : { ...(recorded.inputTokens === undefined ? {} : { inputTokens: recorded.inputTokens }), ...(recorded.outputTokens === undefined ? {} : { outputTokens: recorded.outputTokens }), ...(recorded.cachedInputTokens === undefined ? {} : { cachedInputTokens: recorded.cachedInputTokens }) }
    return { attemptId: attempt.attemptId, attemptNo: attempt.attemptNo, modelId: attempt.candidate.id, providerId: attempt.candidate.providerId, ...(usageJson === undefined ? {} : { usage: usageJson }) }
  }) }
}

export function createModelEffectExecutor(config: { router: ModelRouter; providers: ReadonlyMap<string, ProviderAdapter>; requirements?: Partial<ModelCandidate['capabilities']> }): EffectExecutor {
  const fallback = new ModelFallbackController()
  return async (effect, signal): Promise<EffectExecution> => {
    if (effect.kind !== 'llm') throw new Error(`UNSUPPORTED_EFFECT_KIND:${effect.kind}`)
    const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
    const task = input.task
    const request = input.request
    if (typeof task !== 'string' || !request || typeof request !== 'object' || Array.isArray(request)) throw new Error('INVALID_LLM_EFFECT_INPUT')
    const projection = request as unknown as LLMRequestProjection
    const observations: NonNullable<EffectExecution['observations']> = []
    const usage = new Map<string, NonNullable<LLMResult['usage']>>()
    let lastSchemaViolation: JsonValue | undefined
    let failedForSchema = false
    const dynamicRequirements = input.requirements && typeof input.requirements === 'object' && !Array.isArray(input.requirements) ? input.requirements as Partial<ModelCandidate['capabilities']> : {}
    const candidates = config.router.routeProjection(task, projection, { ...config.requirements, ...dynamicRequirements })
    const result = await fallback.execute(effect.id, candidates, async (attempt) => {
      const provider = config.providers.get(attempt.candidate.providerId)
      if (!provider) throw modelFallbackError({ retryable: false, localClosed: true, sideEffectState: 'none', cause: new Error(`UNKNOWN_PROVIDER:${attempt.candidate.providerId}`) })
      try {
        const output = validateAdapterResult(await provider.executeAttempt({ request: projection, signal, onObservation: (chunk) => observations.push({ type: 'chunk', data: chunk }) }))
        if (output.usage) usage.set(attempt.attemptId, output.usage)
        if (input.outputSchema !== undefined) {
          const candidateValue = output.structured ?? output.text
          if (!validateJsonSchema(candidateValue, input.outputSchema)) {
            lastSchemaViolation = toJson(candidateValue)
            failedForSchema = true
            throw new OutputValidationError('structured', 'OUTPUT_SCHEMA_VIOLATION', 'Provider output did not match the declared schema')
          }
        }
        failedForSchema = false
        return output
      } catch (cause) {
        throw modelFallbackError({ retryable: true, localClosed: true, sideEffectState: 'none', cause })
      }
    }).catch((cause) => {
      if (failedForSchema && lastSchemaViolation !== undefined) return { result: { text: '', toolCalls: [], finishReason: 'error' as const }, candidate: candidates.at(-1)!, attempts: [], schemaRejected: lastSchemaViolation }
      throw cause
    })
    if ('schemaRejected' in result) return { value: null, status: 'failed', executionState: 'failed', privacy: projection.privacy, error: { code: 'OUTPUT_SCHEMA_VIOLATION', message: 'Provider output did not match the declared schema.' }, rejectedOutput: { value: result.schemaRejected, privacy: projection.privacy, derivedFrom: [...(effect.derivedFrom ?? [])] } }
    const modelValue = input.outputSchema !== undefined || typeof input.schema === 'string' ? (result.result.structured ?? result.result.text) : result.result
    const value = toJson(modelValue)
    return { value, privacy: projection.privacy, sideEffectState: 'none', executionState: 'succeeded', metadata: candidateMetadata(result.candidate, result.attempts, usage), ...(observations.length ? { observations } : {}) }
  }
}
