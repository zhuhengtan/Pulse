import type { EffectExecutor, EffectExecution } from '@pulse/runtime'
import { ToolRegistry } from '@pulse/tool-sdk'

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
    const output = await registry.execute(name, input.arguments ?? {}, signal)
    return { value: toJson(output), sideEffectState: definition.manifest.sideEffectPolicy === 'write' ? 'applied' : 'none', executionState: 'succeeded' }
  }
}
