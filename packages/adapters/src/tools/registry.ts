import type { EffectExecutor, EffectExecution, EffectRecord, JsonValue } from '@pulse/runtime'
import { ToolRegistry, type ReconcileResult } from '@pulse/tool-sdk'

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
    const definition = registry.get(name)
    if (!definition) throw new Error(`UNKNOWN_TOOL:${name}`)
    const observations: NonNullable<EffectExecution['observations']> = []
    const detailed = await registry.executeDetailed(name, input.arguments ?? {}, {
      toolCallId: effect.toolCallId ?? '',
      effectId: effect.id,
      attemptId: effect.attemptId,
      ...(effect.idempotencyKey === undefined ? {} : { idempotencyKey: effect.idempotencyKey }),
      agentId: effect.agentId,
      laneId: effect.ownerLaneId,
      signal,
      emit: (event) => { if (!signal.aborted) observations.push(event) },
    })
    const summary = detailed.summary === undefined ? undefined : toJson(detailed.summary)
    if (summary !== undefined && JSON.stringify(summary).length > 4096) throw new Error('TOOL_SUMMARY_TOO_LARGE')
    return { value: toJson(detailed.output), ...(summary === undefined ? {} : { summary }), sideEffectState: definition.manifest.sideEffectPolicy === 'write' ? 'applied' : 'none', executionState: 'succeeded', metadata: { toolVersion: detailed.manifest.version, retrySafety: detailed.manifest.retrySafety, defaultTimeoutMs: detailed.manifest.defaultTimeoutMs, observationCount: observations.length }, ...(observations.length ? { observations } : {}) }
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
