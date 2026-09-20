import type { JsonValue, RuntimeAction } from '../core/types.js'
import type { LLMResult } from './router.js'
import { validateActionToolCalls, validateAdapterResult } from './router.js'

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonValue(item)]))
  throw new Error('ACTION_INPUT_NOT_SERIALIZABLE')
}

export interface ActionDecoderOptions {
  allowedTools: ReadonlySet<string>
  wait?: boolean
  llmEffectId?: string
}

export function decodeLLMActions(result: LLMResult, options: ActionDecoderOptions): RuntimeAction[] {
  validateAdapterResult(result)
  validateActionToolCalls(result, options.allowedTools)
  if (result.finishReason !== 'tool_calls') return []
  if (result.toolCalls.length === 0) throw new Error('INVALID_TOOL_CALL_FINISH_REASON')
  return [{
    type: 'submit_effects',
    effects: result.toolCalls.map((call) => ({ key: `tool:${call.toolCallId}`, toolCallId: call.toolCallId, ...(options.llmEffectId === undefined ? {} : { llmEffectId: options.llmEffectId }), kind: 'tool' as const, concurrencyClass: 'tool' as const, input: { toolCallId: call.toolCallId, name: call.name, arguments: toJsonValue(call.input) } })),
    ...(options.wait === false ? {} : { wait: { onUnsatisfied: 'resume_with_error' as const, reason: 'effect' as const } }),
  }]
}
