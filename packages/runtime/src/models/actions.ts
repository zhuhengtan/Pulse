import type { JsonValue, PrivacyLabel, ProvenanceRef, RuntimeAction } from '../core/types.js'
import type { LLMResult } from './router.js'
import { validateActionToolCalls, validateAdapterResult } from './router.js'

function toJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('ACTION_INPUT_NOT_SERIALIZABLE'); return value }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('ACTION_INPUT_NOT_SERIALIZABLE')
    seen.add(value)
    try { return value.map((item) => toJsonValue(item, seen)) } finally { seen.delete(value) }
  }
  if (typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Date || Object.getPrototypeOf(value) !== Object.prototype || seen.has(value)) throw new Error('ACTION_INPUT_NOT_SERIALIZABLE')
    seen.add(value)
    try { return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonValue(item, seen)])) } finally { seen.delete(value) }
  }
  throw new Error('ACTION_INPUT_NOT_SERIALIZABLE')
}

export interface ActionDecoderOptions {
  allowedTools: ReadonlySet<string>
  wait?: boolean
  llmEffectId?: string
  privacy?: PrivacyLabel
  derivedFrom?: ProvenanceRef[]
}

function cloneProvenanceRefs(refs: readonly ProvenanceRef[] | undefined): ProvenanceRef[] | undefined {
  return refs === undefined ? undefined : refs.map((ref) => typeof ref === 'string' ? ref : { ...ref })
}

export function decodeLLMActions(result: LLMResult, options: ActionDecoderOptions): RuntimeAction[] {
  validateAdapterResult(result)
  validateActionToolCalls(result, options.allowedTools)
  if (result.finishReason !== 'tool_calls') return []
  if (result.toolCalls.length === 0) throw new Error('INVALID_TOOL_CALL_FINISH_REASON')
  const privacy = options.privacy ?? result.privacy
  const inheritedDerivedFrom = cloneProvenanceRefs(options.derivedFrom ?? result.derivedFrom)
  return [{
    type: 'submit_effects',
    effects: result.toolCalls.map((call) => {
      const derivedFrom = inheritedDerivedFrom === undefined ? undefined : cloneProvenanceRefs(inheritedDerivedFrom)
      const input: Record<string, JsonValue> = { toolCallId: call.toolCallId, name: call.name, arguments: toJsonValue(call.input) }
      if (privacy !== undefined) input.privacy = privacy
      if (derivedFrom !== undefined) input.derivedFrom = derivedFrom as unknown as JsonValue
      return {
        key: `tool:${call.toolCallId}`,
        toolCallId: call.toolCallId,
        ...(options.llmEffectId === undefined ? {} : { llmEffectId: options.llmEffectId }),
        ...(privacy === undefined ? {} : { privacy }),
        ...(derivedFrom === undefined ? {} : { derivedFrom }),
        kind: 'tool' as const,
        concurrencyClass: 'tool' as const,
        input,
      }
    }),
    ...(options.wait === false ? {} : { wait: { onUnsatisfied: 'resume_with_error' as const, reason: 'effect' as const } }),
  }]
}
