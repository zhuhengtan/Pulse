import type { EffectExecutor, EffectExecution, EffectRecord, EffectSubmission, JsonValue } from '@pulse/runtime'
import { ToolRegistry, type ReconcileResult, type ToolDiscoveryQuery } from '@pulse/tool-sdk'

function toJson(value: unknown): import('@pulse/runtime').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(toJson)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJson(item)]))
  throw new Error('TOOL_OUTPUT_NOT_SERIALIZABLE')
}

export function createToolEffectExecutor(registry: ToolRegistry): EffectExecutor {
  return async (effect, signal): Promise<EffectExecution> => {
    if (effect.kind !== 'tool') throw new Error(`UNSUPPORTED_EFFECT_KIND:${effect.kind}`)
    const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, import('@pulse/runtime').JsonValue> : {}
    const name = input.name
    if (typeof name !== 'string') throw new Error('INVALID_TOOL_EFFECT_INPUT')
    if (!registry.isAllowed(name)) throw new Error(`TOOL_NOT_ALLOWED:${name}`)
    const definition = registry.get(name)
    if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`)
    const toolContext = {
      toolCallId: effect.toolCallId ?? '',
      effectId: effect.id,
      attemptId: effect.attemptId,
      ...(effect.idempotencyKey === undefined ? {} : { idempotencyKey: effect.idempotencyKey }),
      agentId: effect.agentId,
      laneId: effect.ownerLaneId,
      signal,
      emit: (_event: { type: 'progress' | 'warning' | 'diagnostic'; data: JsonValue }) => undefined,
    }
    const executionRef = registry.executionRef(name, input.arguments ?? {}, toolContext)
    const observations: NonNullable<EffectExecution['observations']> = []
    let detailed: Awaited<ReturnType<ToolRegistry['executeDetailed']>>
    try {
      detailed = await registry.executeDetailed(name, input.arguments ?? {}, {
        toolCallId: effect.toolCallId ?? '',
        effectId: effect.id,
        attemptId: effect.attemptId,
        ...(effect.idempotencyKey === undefined ? {} : { idempotencyKey: effect.idempotencyKey }),
        agentId: effect.agentId,
        laneId: effect.ownerLaneId,
        signal,
        emit: (event) => { if (!signal.aborted) observations.push(event) },
      })
    } catch (error) {
      if (signal.aborted && definition.manifest.sideEffectPolicy === 'write') return { value: null, executionState: 'remote_unknown', sideEffectState: 'unknown', ...(executionRef === undefined ? {} : { executionRef }), metadata: { toolVersion: definition.manifest.version, reconcileRequired: true }, ...(error instanceof Error ? { error: { code: 'TOOL_CANCELLED_UNKNOWN', message: error.message } } : {}) }
      throw error
    }
    const summary = detailed.summary === undefined ? undefined : toJson(detailed.summary)
    if (summary !== undefined && JSON.stringify(summary).length > 4096) throw new Error('TOOL_SUMMARY_TOO_LARGE')
    return { value: toJson(detailed.output), ...(summary === undefined ? {} : { summary }), sideEffectState: definition.manifest.sideEffectPolicy === 'write' ? 'applied' : 'none', executionState: 'succeeded', ...(executionRef === undefined ? {} : { executionRef }), metadata: { toolVersion: detailed.manifest.version, retrySafety: detailed.manifest.retrySafety, defaultTimeoutMs: detailed.manifest.defaultTimeoutMs, observationCount: observations.length }, ...(observations.length ? { observations } : {}) }
  }
}

export async function reconcileToolEffect(registry: ToolRegistry, effect: Readonly<EffectRecord>, signal: AbortSignal): Promise<ReconcileResult<JsonValue>> {
  if (effect.kind !== 'tool') throw new Error(`UNSUPPORTED_EFFECT_KIND:${effect.kind}`)
  if (effect.executionRef === undefined) throw new Error('MISSING_TOOL_EXECUTION_REF')
  const input = effect.input && typeof effect.input === 'object' && !Array.isArray(effect.input) ? effect.input as Record<string, JsonValue> : {}
  if (typeof input.name !== 'string') throw new Error('INVALID_TOOL_EFFECT_INPUT')
  const result = await registry.reconcileDetailed(input.name, effect.executionRef, { toolCallId: effect.toolCallId ?? '', effectId: effect.id, attemptId: effect.attemptId, agentId: effect.agentId, laneId: effect.ownerLaneId, signal })
  return { status: result.status, ...(result.error === undefined ? {} : { error: result.error }), ...(result.output === undefined ? {} : { output: toJson(result.output) }) }
}

export function createToolEffectSubmissionPreparer(registry: ToolRegistry): (submission: EffectSubmission) => EffectSubmission {
    return (submission) => {
    if (submission.kind === 'llm') {
      const input = submission.input && typeof submission.input === 'object' && !Array.isArray(submission.input) ? submission.input as Record<string, JsonValue> : {}
      const rawQuery = input.toolDiscovery
      if (rawQuery && typeof rawQuery === 'object' && !Array.isArray(rawQuery)) {
        const query = rawQuery as ToolDiscoveryQuery
        const requestedId = typeof input.toolSetId === 'string' ? input.toolSetId : 'dynamic'
        const toolSet = registry.compileToolSet(requestedId, query)
        const tools = toolSet.tools.map((manifest) => ({ name: manifest.name, description: manifest.description, inputSchema: manifest.inputSchema as JsonValue }))
        return { ...submission, input: { ...input, toolSetId: `${toolSet.id}@${toolSet.version}`, tools: { tools } } }
      }
      return submission
    }
    if (submission.kind !== 'tool') return submission
    const input = submission.input && typeof submission.input === 'object' && !Array.isArray(submission.input) ? submission.input as Record<string, JsonValue> : {}
    if (typeof input.name !== 'string') return submission
    try {
      const admission = registry.admission(input.name, input.arguments ?? {})
      return { ...submission, ...(submission.locks === undefined ? { locks: admission.locks } : {}), ...(submission.sideEffectPolicy === undefined ? { sideEffectPolicy: admission.sideEffectPolicy } : {}), ...(submission.attemptTimeoutMs === undefined ? { attemptTimeoutMs: admission.defaultTimeoutMs } : {}) }
    } catch {
      return submission
    }
  }
}
